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
 *   - update_modules_many — module structure edits (1..N modules).
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
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import { keepStoredDefaults, storedModuleFields } from "./_module-field-defaults.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import {
  MODULE_BIND_THEME_LITERALS_DESCRIPTION,
  MODULE_CSS_DESCRIPTION,
  MODULE_HTML_DESCRIPTION,
  MODULE_JS_CONTRACT,
} from "./_module-js-contract.js";
import { moduleJsGuardSuffix } from "./_module-js-guard.js";
import { bindCssToTheme } from "./_theme-binding.js";
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
const deleteInput = z.object({ items: z.array(deletionItem).min(1).max(200) }).strict();
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
  const cascading = input.items.filter((d) => d.children === "delete").map((d) => d.pageId);
  if (cascading.length === 0) return input.items.length;
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok) throw new Error(`pages.list failed: ${describeError(listed.error)}`);
  const rows = (listed.value as { pages: { id: string; parentPageId: string | null }[] }).pages;
  const doomed = new Set(input.items.map((d) => d.pageId));
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
  description: [
    "Soft-delete 1..N pages — the ONLY page delete tool.",
    "CORE RULES:",
    "- Each item's `disposition` handles its dead URL: ALWAYS confirm it with the operator; for `redirect` suggest a target (parent section, sibling, `/`). Items may differ.",
    "- A page with child pages is refused unless the call also deletes all of them or the item sets `children` — ask the operator which when unclear.",
    `- ${DELETE_PAGES_MANY_APPROVAL_THRESHOLD}+ pages (subtrees counted) pause for one Owner click in chat before running.`,
    "- One snapshot per page (undo: `propose_revert_site` / `propose_revert_page`). Result: deleted/alreadyDeleted/notFound counts + each refused page with reason.",
  ].join("\n"),
  // A `children: "delete"` item deletes its whole subtree: count it.
  needsApproval: async (input, ctx, toolCtx) =>
    (await countDeletedPages(ctx, toolCtx, input)) >= DELETE_PAGES_MANY_APPROVAL_THRESHOLD,
  // #589 — deleting pages in the editor needs content.write.
  approverPermissions: ["content.write"],
  buildApprovalPreview: async (input, ctx, toolCtx) => ({
    op: "delete_pages_many",
    pageCount: await countDeletedPages(ctx, toolCtx, input),
    samplePageIds: input.items.slice(0, 5).map((d) => d.pageId),
  }),
  schema: deleteInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
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
              description: "`redirect` = 301 to `redirectTo`.",
            },
            redirectTo: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description:
                "Required for `redirect`: on-site path with one leading `/` (e.g. `/blog`); never a full URL or `//host`.",
            },
            children: {
              type: "string",
              enum: ["refuse", "move-up", "delete"],
              description:
                "Page with child pages: `move-up` -> to this page's parent (old URLs 301) | `delete` -> whole subtree, same disposition.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.delete_many", {
      deletions: input.items,
    });
    if (!r.ok) {
      return { ok: false, content: `pages.delete_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      deleted: number;
      alreadyDeleted: number;
      notFound: number;
      refused: { pageId: string; reason: string }[];
    };
    const redirected = input.items.filter((d) => d.disposition === "redirect").length;
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
    title: z.string().min(1).max(256).optional(),
    shortTitle: pageUpdateSchema.shape.shortTitle,
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
const updateInput = z.object({ items: z.array(pageUpdateItem).min(1).max(200) }).strict();
type UpdateInput = z.infer<typeof updateInput>;

/** URLs the renames in an update_pages_many call move, summed per item. */
async function countRenamedUrls(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: UpdateInput,
): Promise<number> {
  let total = 0;
  for (const u of input.items) {
    if (u.slug === undefined) continue;
    total += (await countMovedUrls(ctx, toolCtx, [{ pageId: u.pageId, newSlug: u.slug }])).count;
  }
  return total;
}

export const updatePagesManyTool: ToolDefinitionWithHandler<UpdateInput> = {
  name: "update_pages_many",
  description: [
    "Edit metadata of 1..N pages — the ONLY tool for it: rename, retitle, reslug, status, template, page type, properties, terms.",
    "DO NOT USE FOR: nesting under another page / back to top level -> `move_pages`; SEO -> `set_page_seo_many`; modules -> `update_modules_many`.",
    "CORE RULES:",
    "- THREE independent identifiers, never substitute one for another: `title` (HTML <title>), `shortTitle` (label in breadcrumbs, menus, page picker; translated with the page), `slug` (URL). 'Rename this page' = `title` + `shortTitle`; the URL only when the operator asks.",
    `- Changing \`slug\` moves the page's URL AND every nested page's URL; a 301 from each old URL is created in the same transaction. On-site links (menus, link lists, modules, content) follow automatically — do not update them. A slug change moving ${PAGE_MOVE_APPROVAL_THRESHOLD}+ URLs (page + subtree) pauses for one Owner click in chat.`,
    "- Items apply independently: per-item failures (not found, version conflict) are reported, the rest applies.",
  ].join("\n"),
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
    required: ["items"],
    properties: {
      items: {
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
            title: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description: "HTML `<title>`: browser tab + search results.",
            },
            shortTitle: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description:
                "Short public label in breadcrumbs, navigation and the page picker. Every trail showing the page follows it.",
            },
            slug: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description: "URL path segment.",
            },
            templateId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["draft", "published", "archived"] },
            pageType: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              description:
                "What the page IS (`list_page_types` slug, e.g. `news`); page queries ('latest news', 'articles in this category') filter on type/properties/terms. Template must be one of the type's templates, else pass `templateId` too.",
            },
            properties: {
              type: "object",
              description:
                "Page type properties, merged (null removes one), e.g. `{author:'Ada', event_date:'2026-11-03'}`.",
              additionalProperties: true,
            },
            terms: {
              type: "array",
              maxItems: 100,
              items: { type: "string", pattern: "^caelo:term/[0-9a-f-]{36}/[0-9a-f-]{36}$" },
              description:
                "REPLACES the page's terms, from the page type's vocabularies (categories, tags; `get_list` shows entry ids). `[]` clears.",
            },
            redirectFromOld: {
              type: "string",
              enum: ["auto", "skip"],
              description:
                "Only with `slug`. `skip` = no 301 — ONLY when the operator explicitly wants the old URL to 404.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.update_many", {
      updates: input.items,
    });
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

// The ONE module-structure write tool (the former singular edit_module is
// its n=1 case — retired-tools.ts maps old calls here). Items reuse the
// shared `moduleUpdateSchema` (the SAME schema modules.update /
// modules.update_many validate against), so the tool can never be a subset
// of the op. Source fields decode whole-value transport encodings (CDATA,
// JSON string literal, HTML-escaped) like every other AI authoring surface
// (`sourceTextArg`); the op's own checks still apply to the result. An item
// that changes nothing is refused before any lookup (e2e-livedit run
// 40351690739: a bare placeholder moduleId came back as "module not found").
const moduleUpdateItem = moduleUpdateSchema
  .extend({
    html: sourceTextArg(moduleUpdateSchema.shape.html.unwrap(), "html").optional(),
    css: sourceTextArg(moduleUpdateSchema.shape.css.unwrap(), "css").optional(),
    js: sourceTextArg(moduleUpdateSchema.shape.js.unwrap(), "js").optional(),
    bindThemeLiterals: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "moduleId" && k !== "bindThemeLiterals"), {
    message:
      "this item changes nothing: pass what to change (html, css, js, fields, displayName, description, kind or type). list_modules shows the modules; add_module creates a new one.",
  });
const moduleUpdateInput = z.object({ items: z.array(moduleUpdateItem).min(1).max(200) }).strict();
type ModuleUpdateInput = z.infer<typeof moduleUpdateInput>;
type ModuleUpdateItem = z.infer<typeof moduleUpdateItem>;

/** What modules.update_many reports (see ops/content/modules.ts). */
interface ModuleUpdateManyResult {
  readonly updated: number;
  readonly notFoundIds: readonly string[];
  readonly failed: readonly { moduleId: string; message: string }[];
  readonly extracted: readonly { moduleId: string; fields: { name: string; kind: string }[] }[];
}

/**
 * The hint for an item whose html came without `fields[]`: the extractor
 * minted heuristic names, which pollute the `list_modules` catalog the AI
 * later picks modules from (CLAUDE.md §1A). Names them verbatim so the next
 * call can rename them.
 */
export function extractedFieldsHint(fields: readonly { name: string; kind: string }[]): string {
  const list = fields.map((f) => `${f.name} (${f.kind})`).join(", ");
  return (
    ` Extractor fallback used — heuristic field names: ${list}. Next time author \`html\` + \`fields\` together ` +
    "with semantic snake_case names (e.g. `hero_title`, `primary_cta_href`) so the `list_modules` catalog stays useful; " +
    "rename them now with a follow-up update_modules_many item carrying explicit `fields` if they are confusing."
  );
}

/**
 * Per-item post-write notes for an updated module: theme-binding report,
 * unknown css vars against the active theme, and the static design-guard
 * findings (scope, literals, kit ids, markup reuse) — the same checks the
 * singular edit ran, now per item.
 */
async function updatedItemNotes(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  item: ModuleUpdateItem,
  writtenCss: string | undefined,
  bindingReport: string,
): Promise<string> {
  const cssWarn = await cssVarWarningSuffix(ctx, toolCtx, writtenCss);
  const guard = await designGuardSuffix(ctx, toolCtx, {
    css: writtenCss,
    ...(item.html !== undefined
      ? { html: item.html, excludeModuleIds: [item.moduleId] }
      : { scopeModuleId: item.moduleId }),
  });
  return `${bindingReport}${cssWarn}${guard}`;
}

export const updateModulesManyTool: ToolDefinitionWithHandler<ModuleUpdateInput> = {
  name: "update_modules_many",
  description: [
    "Edit module structure (`html`, `fields`, `css`, `js`, `displayName`, `description`, `kind`, `type`) of 1..N modules. Every page using a module follows; chat-branched until publish.",
    "USE FOR: wholesale rewrites, new module bodies, changes to `fields`/`displayName`/`kind`/`type`/`description`, the same fix across modules.",
    "DO NOT USE FOR: a TARGETED change to existing `html`/`css`/`js` -> PREFER `edit_content` (surgical string-replace: cheaper, reviewable diff); page/instance content -> `set_page_module_content_many` (per page) | `set_content_instance_values_many` (shared); page metadata -> `update_pages_many`; templates -> `propose_update_template`.",
    "CORE RULES:",
    "- AUTHOR EXPLICITLY: pair `{{field_name}}` placeholders in `html` with explicit `fields[]` in semantic snake_case (`hero_title`, `primary_cta_href`, `nav_items`); never heuristic names (`cta2label2`, `spanText`).",
    '- LISTS ARE LISTS: 10-item menu = ONE `list` field, never `label1`..`label10`; tag cloud = ONE `list` (`listType:"texts"`); multi-part items (image + heading + text) -> custom list type (`upsert_list_types_many`) or a `module-list` of a card module.',
    "- KEEP METADATA FRESH: update `description` + `kind` when a module's purpose drifts (`list_modules` relies on them).",
    '- `fields` is the WHOLE list (omitted fields are dropped): read it first with `read_content` `field:"fields"` and resend every field. A field resent without `default` keeps its stored one.',
    "- Items apply independently: a failed item (not found, draft conflict, invalid field) is reported with its reason, the rest commits; nothing updated -> error. One snapshot per module.",
    INTERNAL_LINK_CONTRACT,
  ].join("\n"),
  schema: moduleUpdateInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
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
            // Same shared meta + fields schemas add_module / build_page use —
            // one authoring surface across the module tools.
            ...MODULE_META_JSON_SCHEMA_PROPS,
            html: {
              type: "string",
              description: MODULE_HTML_DESCRIPTION,
            },
            css: {
              type: "string",
              description: MODULE_CSS_DESCRIPTION,
            },
            js: { type: "string", description: MODULE_JS_CONTRACT },
            fields: MODULE_FIELDS_JSON_SCHEMA,
            bindThemeLiterals: {
              type: "boolean",
              description: MODULE_BIND_THEME_LITERALS_DESCRIPTION,
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Mechanical token binding before the write, per item (on unless the
    // item passes `bindThemeLiterals: false`); the flag never reaches the op.
    const opItems: Record<string, unknown>[] = [];
    const bindingReports: string[] = [];
    const keptDefaults = new Map<string, string[]>();
    for (const item of input.items) {
      const { bindThemeLiterals, ...rest } = item;
      let opItem = rest;
      // #1100 — a field resent without `default` keeps the stored one.
      if (rest.fields !== undefined && rest.fields.length > 0) {
        const stored = await storedModuleFields(ctx, toolCtx, rest.moduleId);
        if (stored !== null) {
          const merged = keepStoredDefaults(rest.fields, stored);
          opItem = { ...rest, fields: merged.fields };
          if (merged.kept.length > 0) keptDefaults.set(rest.moduleId, merged.kept);
        }
      }
      if (bindThemeLiterals !== false && typeof opItem.css === "string") {
        const bound = await bindCssToTheme(ctx, toolCtx, opItem.css);
        opItems.push({ ...opItem, css: bound.css });
        bindingReports.push(bound.report);
      } else {
        opItems.push(opItem);
        bindingReports.push("");
      }
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.update_many", {
      updates: opItems,
    });
    if (!r.ok) {
      return { ok: false, content: `modules.update_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as ModuleUpdateManyResult;
    const notFound = new Set(v.notFoundIds);
    const failedById = new Map(v.failed.map((f) => [f.moduleId, f.message]));
    const extractedById = new Map(v.extracted.map((e) => [e.moduleId, e.fields]));
    // #1038 — one line per item with its outcome, so the AI fixes exactly
    // the failed item (re-read after a draft conflict, correct a field).
    const lines: string[] = [];
    const scriptTouched: string[] = [];
    for (const [i, item] of input.items.entries()) {
      if (notFound.has(item.moduleId)) {
        lines.push(`- ${item.moduleId}: module not found — check the id with list_modules.`);
        continue;
      }
      const failure = failedById.get(item.moduleId);
      if (failure !== undefined) {
        lines.push(`- ${item.moduleId}: not applied — ${failure}`);
        continue;
      }
      if (item.js !== undefined || item.html !== undefined) scriptTouched.push(item.moduleId);
      const writtenCss = opItems[i]?.css as string | undefined;
      const notes = await updatedItemNotes(ctx, toolCtx, item, writtenCss, bindingReports[i] ?? "");
      const extracted = extractedById.get(item.moduleId);
      const kept = keptDefaults.get(item.moduleId);
      const keptNote =
        kept && kept.length > 0 ? ` Kept the stored default of: ${kept.join(", ")}.` : "";
      lines.push(
        `- ${item.moduleId}: updated${keptNote}${notes}${extracted && extracted.length > 0 ? extractedFieldsHint(extracted) : ""}`,
      );
    }
    const summary = `Updated ${v.updated} of ${input.items.length} module(s) (notFound=${notFound.size}, failed=${v.failed.length}).`;
    // #1198 — one read for every module whose script or markup changed.
    const jsGuard = await moduleJsGuardSuffix(ctx, toolCtx, scriptTouched);
    return { ok: v.updated > 0, content: `${summary}\n${lines.join("\n")}${jsGuard}` };
  },
};
