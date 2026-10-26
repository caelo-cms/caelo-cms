// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.33 — bulk AI tools for pages + modules. CLAUDE.md §11 says
 * "every routine domain ships a bulk variant alongside the singular
 * form ... AI plans a multi-row change and posts it in one tool call;
 * saves token cycles + tool-call rounds + a wall of tool-call →
 * tool-result events in chat."
 *
 * Tools added here:
 *   - delete_pages_many — operator's "drop these 12 stale blog posts" case.
 *   - update_pages_many — bulk metadata edits (title/slug/status/template).
 *   - update_modules_many — bulk module body edits.
 *
 * Each wraps the corresponding *_many op (pages.delete_many,
 * pages.update_many, modules.update_many — all soft-delete /
 * atomic-per-row, never all-or-nothing).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  moduleUpdateSchema,
  pageUpdateSchema,
  redirectTargetPathSchema,
  sourceTextArg,
} from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import {
  MODULE_CSS_DESCRIPTION,
  MODULE_HTML_DESCRIPTION,
  MODULE_JS_CONTRACT,
} from "./_module-js-contract.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";
import { countMovedUrls, PAGE_MOVE_APPROVAL_THRESHOLD } from "./move-pages.js";

const uuid = z.string().uuid();

// ─── delete_pages_many ───────────────────────────────────────────────

// audit #4 — each deletion carries its own dead-URL disposition (folds the
// former singular `delete_page` tool: n=1 is a one-item array). `disposition`
// is REQUIRED per item so the AI can never silently leave a dead URL
// unredirected — the guard that used to live on delete_page.
const deletionItem = z
  .object({
    pageId: uuid,
    disposition: z.enum(["404", "redirect"]),
    redirectTo: redirectTargetPathSchema.optional(),
    children: z.enum(["refuse", "move-up", "delete"]).optional(),
  })
  .strict()
  .refine((v) => v.disposition !== "redirect" || !!v.redirectTo, {
    message: "disposition 'redirect' requires redirectTo",
  });
const deleteInput = z.object({ deletions: z.array(deletionItem).min(1).max(200) }).strict();
type DeleteInput = z.infer<typeof deleteInput>;

/**
 * v0.6.0 W5 reference migration — the FIRST tool to use the
 * needsApproval gate from packages/admin-core/src/ai/tools/dispatch.ts.
 *
 * Per CLAUDE.md §11.A, hard-to-revert ops should be Owner-gated. The
 * earlier propose/execute pattern (per-domain `*_pending_actions`
 * table + propose_* op + execute_proposal op) carries audit history +
 * preview metadata for high-stakes ops like layouts.create. For
 * delete_pages_many, that machinery is overkill — the action is
 * snapshot-recoverable, the preview is just "N page IDs", and the
 * audit row is already on `audit_log`. needsApproval gives the same
 * one-click gate without the table.
 *
 * Threshold: 5+ pages triggers approval. 1-4 runs immediately
 * (matches the existing UX where a small bulk delete feels safe).
 * Operator-tunable in code if production data suggests a different
 * floor.
 */
const DELETE_PAGES_MANY_APPROVAL_THRESHOLD = 5;

/**
 * Pages a delete_pages_many call removes: the listed pages plus, for
 * `children: "delete"` items, every page below them (#690).
 */
async function countDeletedPages(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: DeleteInput,
): Promise<number> {
  const cascading = input.deletions.filter((d) => d.children === "delete").map((d) => d.pageId);
  if (cascading.length === 0) return input.deletions.length;
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok) throw new Error(`pages.list failed: ${describeError(listed.error)}`);
  const rows = (listed.value as { pages: { id: string; parentPageId: string | null }[] }).pages;
  const doomed = new Set(input.deletions.map((d) => d.pageId));
  const queue = [...cascading];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const r of rows) {
      if (r.parentPageId === id && !doomed.has(r.id)) {
        doomed.add(r.id);
        queue.push(r.id);
      }
    }
  }
  return doomed.size;
}

export const deletePagesManyTool: ToolDefinitionWithHandler<DeleteInput> = {
  name: "delete_pages_many",
  description:
    "Soft-delete pages — the ONE delete tool, for 1 page or 200 (pass a single-item `deletions` array for one page; there is no separate delete_page tool). " +
    "Use when the operator says 'delete this page', 'delete these N pages', 'drop these stale posts', 'remove the entire {category} tree'. " +
    "**Each page needs a `disposition` for its dead URL** — never leave that to chance: " +
    "`'404'` = the old URL returns not-found; `'redirect'` = a 301 from the old URL to `redirectTo` (required for that item). " +
    "ALWAYS confirm the disposition with the operator, and when proposing 'redirect' suggest a sensible target (parent section, sibling page, or /). " +
    "Different pages in one call may take different dispositions. Each page emits its own snapshot, so `propose_revert_site` (or individual `revert_page`) restores them. " +
    "**Pages with child pages** (nested under them) are refused unless the call also deletes all those children, or the item says what happens to them: `children: 'move-up'` (they move to the deleted page's parent, old URLs 301) or `children: 'delete'` (the whole subtree goes, same disposition). Ask the operator which, when it isn't clear. " +
    "Result: deleted / alreadyDeleted / notFound counts, plus each refused page with the reason. " +
    `Deleting ${DELETE_PAGES_MANY_APPROVAL_THRESHOLD}+ pages needs one Owner click in chat before the delete runs.`,
  // A `children: "delete"` item deletes its whole subtree: count it.
  needsApproval: async (input, ctx, toolCtx) =>
    (await countDeletedPages(ctx, toolCtx, input)) >= DELETE_PAGES_MANY_APPROVAL_THRESHOLD,
  // #589 — deleting pages in the editor needs content.write.
  approverPermissions: ["content.write"],
  buildApprovalPreview: async (input, ctx, toolCtx) => ({
    op: "delete_pages_many",
    pageCount: await countDeletedPages(ctx, toolCtx, input),
    samplePageIds: input.deletions.slice(0, 5).map((d) => d.pageId),
  }),
  schema: deleteInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["deletions"],
    properties: {
      deletions: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageId", "disposition"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            disposition: {
              type: "string",
              enum: ["404", "redirect"],
              description:
                "What the dead URL does: '404' = not-found; 'redirect' = 301 to redirectTo.",
            },
            redirectTo: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description:
                "Required when disposition='redirect' — the 301 target: a path on this site starting with a single '/' (e.g. '/blog'). Never a full URL or '//host'; external targets are not supported.",
            },
            children: {
              type: "string",
              enum: ["refuse", "move-up", "delete"],
              description:
                "Only for a page that has child pages: 'move-up' moves them to this page's parent (301s), 'delete' deletes the whole subtree. Default 'refuse'.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.delete_many", input);
    if (!r.ok) {
      return { ok: false, content: `pages.delete_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      deleted: number;
      alreadyDeleted: number;
      notFound: number;
      refused: { pageId: string; reason: string }[];
    };
    const redirected = input.deletions.filter((d) => d.disposition === "redirect").length;
    const refused =
      v.refused.length > 0
        ? `\nNot deleted:\n${v.refused.map((f) => `- ${f.pageId}: ${f.reason}`).join("\n")}`
        : "";
    return {
      ok: true,
      content: `Deleted ${v.deleted} pages (alreadyDeleted=${v.alreadyDeleted}, notFound=${v.notFound}); ${redirected} got a 301, the rest 404. Use \`propose_revert_site\` to undo if needed.${refused}`,
    };
  },
};

// ─── update_pages_many ───────────────────────────────────────────────

const pageUpdateItem = z
  .object({
    pageId: uuid,
    expectedVersion: z.number().int().nonnegative().optional(),
    name: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
    slug: z.string().min(1).max(120).optional(),
    templateId: uuid.optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    /** Only meaningful with `slug`. 'skip' suppresses the automatic 301. */
    redirectFromOld: z.enum(["auto", "skip"]).optional(),
    // Epic #1107 — what the page IS, its properties and its terms; the op
    // (`pageUpdateSchema`) owns the semantics.
    pageType: pageUpdateSchema.shape.pageType,
    properties: pageUpdateSchema.shape.properties,
    terms: pageUpdateSchema.shape.terms,
  })
  .strict();
const updateInput = z.object({ updates: z.array(pageUpdateItem).min(1).max(200) }).strict();
type UpdateInput = z.infer<typeof updateInput>;

/** URLs the renames in an update_pages_many call move, summed per item. */
async function countRenamedUrls(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: UpdateInput,
): Promise<number> {
  let total = 0;
  for (const u of input.updates) {
    if (u.slug === undefined) continue;
    total += (await countMovedUrls(ctx, toolCtx, [{ pageId: u.pageId, newSlug: u.slug }])).count;
  }
  return total;
}

export const updatePagesManyTool: ToolDefinitionWithHandler<UpdateInput> = {
  name: "update_pages_many",
  description:
    "Edit page metadata — the ONE tool for it, for 1 page or 200 (pass a single-item `updates` array for one page; there is no separate rename/retitle/reslug tool). " +
    "Use for 'rename this page', 'change the browser-tab title', 'move this to /pricing', 'archive all draft posts', 'move these pages to the {tpl} template', 'these posts are news articles', 'file this article under Product updates'. " +
    "**What a page IS:** `pageType` (slug from list_page_types — e.g. turn a plain page into a `news` article; pass `templateId` too when the current template is not one of the new type's templates), `properties` (the page type's fields; merged, null removes one) and `terms` (REPLACES the page's terms: caelo:term/<listId>/<itemId> from the type's vocabularies — get_list on the categories / tags list shows the entry ids). Page queries ('latest news', 'articles in this category') filter on these. " +
    "**A page has THREE independently-editable identifiers — never substitute one for another:** " +
    "`name` = the internal editor label (page picker / breadcrumbs; not public), " +
    "`title` = the HTML <title> tag (browser tab + search results), " +
    "`slug` = the URL path. If the operator just says 'rename' without saying which, ASK before guessing — 'rename' usually means `name`. " +
    "**Changing `slug` moves the page's public URL — and the URL of every page nested below it**: a 301 from each old URL is created automatically in the same transaction, for links from outside the site. Links on this site (nav menus, link lists, modules, content) follow the page on their own — do not update them after a rename. " +
    `A rename that moves ${PAGE_MOVE_APPROVAL_THRESHOLD}+ URLs (the page plus its subtree) needs one Owner click in chat before it runs. ` +
    "To put a page under another page (or back at the top level) use move_pages, not this tool. " +
    "Pass `redirectFromOld: 'skip'` ONLY when the operator explicitly says the old URL should 404 — the default keeps inbound links alive. " +
    "Per-item failures (not-found, version conflict) are reported; the rest of the batch still applies. " +
    "DO NOT use for SEO sidecar (`pages_seo.set_many`) or modules (`update_modules_many`) — those have their own bulk tools.",
  // §11.A — a rename of a page with a large subtree moves every URL below
  // it; same gate + threshold as move_pages (see move-pages.ts).
  // Items apply independently (one refused rename does not stop the
  // rest), so the blast radius is summed per rename, not planned jointly.
  needsApproval: async (input, ctx, toolCtx) =>
    (await countRenamedUrls(ctx, toolCtx, input)) >= PAGE_MOVE_APPROVAL_THRESHOLD,
  approverPermissions: ["content.write"],
  buildApprovalPreview: async (input, ctx, toolCtx) => ({
    op: "update_pages_many",
    movedUrlCount: await countRenamedUrls(ctx, toolCtx, input),
  }),
  schema: updateInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updates"],
    properties: {
      updates: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pageId"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            expectedVersion: { type: "integer", minimum: 0 },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description: "Internal editor label (page picker / breadcrumbs). Not public.",
            },
            title: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description: "HTML <title> — browser tab + search results.",
            },
            slug: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description:
                "URL path. Changing it auto-creates a 301 from the old URL; links on the site follow the page automatically.",
            },
            templateId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["draft", "published", "archived"] },
            pageType: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              description:
                "Page type slug (list_page_types). The template must be one of the type's templates — pass templateId too when it is not.",
            },
            properties: {
              type: "object",
              description:
                "Page type properties, merged into the page's (null removes one), e.g. {author: 'Ada', event_date: '2026-11-03'}.",
              additionalProperties: true,
            },
            terms: {
              type: "array",
              maxItems: 100,
              items: { type: "string", pattern: "^caelo:term/[0-9a-f-]{36}/[0-9a-f-]{36}$" },
              description:
                "REPLACES the page's terms: caelo:term/<listId>/<itemId> of the page type's vocabularies (categories, tags). [] clears them.",
            },
            redirectFromOld: {
              type: "string",
              enum: ["auto", "skip"],
              description:
                "Only with `slug`. 'skip' suppresses the 301 — use only if the operator says the old URL should 404.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.update_many", input);
    if (!r.ok) {
      return { ok: false, content: `pages.update_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      updated: number;
      notFound: number;
      failures: { pageId: string; reason: string }[];
    };
    const failureMsg =
      v.failures.length > 0
        ? ` Not applied:\n${v.failures.map((f) => `- ${f.pageId}: ${f.reason}`).join("\n")}`
        : "";
    return {
      ok: true,
      content: `Updated ${v.updated} pages (notFound=${v.notFound}).${failureMsg}`,
    };
  },
};

// ─── update_modules_many ─────────────────────────────────────────────

// audit #4 follow-up — reuse the shared `moduleUpdateSchema` (the SAME schema
// modules.update / modules.update_many validate against) rather than a
// hand-written subset. The old subset was `{moduleId, displayName, html, css,
// js}` — it `.strict()`-rejected `description`/`kind`/`type`/`fields` before
// they reached the op that DOES support them, so a bulk edit could not change
// a module's field schema or metadata and the AI had to fall back to N×
// edit_module (the exact N+1 chain the bulk tool exists to replace). Reusing
// the shared schema means the tool can never be a subset of the op again.
// The source fields additionally decode whole-value transport encodings
// (CDATA, JSON string literal, HTML-escaped), like every other AI authoring
// surface (`sourceTextArg`); the op's own checks still apply to the result.
const moduleUpdateItem = moduleUpdateSchema.extend({
  html: sourceTextArg(moduleUpdateSchema.shape.html.unwrap()).optional(),
  css: sourceTextArg(moduleUpdateSchema.shape.css.unwrap()).optional(),
  js: sourceTextArg(moduleUpdateSchema.shape.js.unwrap()).optional(),
});
const moduleUpdateInput = z.object({ updates: z.array(moduleUpdateItem).min(1).max(200) }).strict();
type ModuleUpdateInput = z.infer<typeof moduleUpdateInput>;

export const updateModulesManyTool: ToolDefinitionWithHandler<ModuleUpdateInput> = {
  name: "update_modules_many",
  description:
    "Bulk module body edits across 1–200 modules in one tool call. " +
    "Use when the operator says 'change the CTA in these 5 hero modules', 'fix the typo across these footer modules', " +
    "'apply this CSS tweak to all card modules'. " +
    "Each item is the FULL `edit_module` shape (moduleId + optional displayName/description/kind/type/html/css/js/fields) — " +
    "including `fields` and `kind`/`description`, so a bulk edit can restructure a module's field schema, not just its body. " +
    "Per-item failures are reported but the rest of the batch still applies. " +
    "Prefer this over multiple `edit_module` calls when targeting > 1 module. Each updated module emits its own " +
    "snapshot, so revert_module (or revert_site) can undo the lot. " +
    "`list` fields take the same shape as in edit_module (listType, bind local | shared | source, list, source, default).",
  schema: moduleUpdateInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updates"],
    properties: {
      updates: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["moduleId"],
          properties: {
            moduleId: { type: "string", format: "uuid" },
            displayName: { type: "string", minLength: 1, maxLength: 256 },
            // Same shared meta + fields schemas add_module / edit_module use —
            // so the bulk tool exposes the identical authoring surface.
            ...MODULE_META_JSON_SCHEMA_PROPS,
            html: { type: "string", description: MODULE_HTML_DESCRIPTION },
            css: { type: "string", description: MODULE_CSS_DESCRIPTION },
            js: { type: "string", description: MODULE_JS_CONTRACT },
            fields: MODULE_FIELDS_JSON_SCHEMA,
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.update_many", input);
    if (!r.ok) {
      return { ok: false, content: `modules.update_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      updated: number;
      notFound: number;
      failed: { moduleId: string; message: string }[];
    };
    // #1038 — each failed item with its reason, so the AI can fix exactly
    // that item (re-read after a draft conflict, correct a field) instead
    // of guessing from a bare id list.
    const failLines = v.failed.map((f) => `\n- ${f.moduleId}: ${f.message}`).join("");
    const failMsg = v.failed.length > 0 ? `, failed=${v.failed.length}` : "";
    return {
      ok: true,
      content: `Updated ${v.updated} modules (notFound=${v.notFound}${failMsg}).${
        v.failed.length > 0 ? `\nNot applied:${failLines}` : ""
      }`,
    };
  },
};
