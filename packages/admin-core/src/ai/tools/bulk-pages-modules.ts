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
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

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
    redirectTo: z.string().min(1).max(500).optional(),
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

export const deletePagesManyTool: ToolDefinitionWithHandler<DeleteInput> = {
  name: "delete_pages_many",
  description:
    "Soft-delete pages — the ONE delete tool, for 1 page or 200 (pass a single-item `deletions` array for one page; there is no separate delete_page tool). " +
    "Use when the operator says 'delete this page', 'delete these N pages', 'drop these stale posts', 'remove the entire {category} tree'. " +
    "**Each page needs a `disposition` for its dead URL** — never leave that to chance: " +
    "`'404'` = the old URL returns not-found; `'redirect'` = a 301 from the old URL to `redirectTo` (required for that item). " +
    "ALWAYS confirm the disposition with the operator, and when proposing 'redirect' suggest a sensible target (parent section, sibling page, or /). " +
    "Different pages in one call may take different dispositions. Each page emits its own snapshot, so `propose_revert_site` (or individual `revert_page`) restores them. " +
    "Result: {deleted, alreadyDeleted, notFound}. " +
    `Deleting ${DELETE_PAGES_MANY_APPROVAL_THRESHOLD}+ pages needs one Owner click in chat before the delete runs.`,
  needsApproval: (input) => input.deletions.length >= DELETE_PAGES_MANY_APPROVAL_THRESHOLD,
  buildApprovalPreview: (input) => ({
    op: "delete_pages_many",
    pageCount: input.deletions.length,
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
              description: "Required when disposition='redirect' — the 301 target path.",
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
    const v = r.value as { deleted: number; alreadyDeleted: number; notFound: number };
    const redirected = input.deletions.filter((d) => d.disposition === "redirect").length;
    return {
      ok: true,
      content: `Deleted ${v.deleted} pages (alreadyDeleted=${v.alreadyDeleted}, notFound=${v.notFound}); ${redirected} got a 301, the rest 404. Use \`propose_revert_site\` to undo if needed.`,
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
  })
  .strict();
const updateInput = z.object({ updates: z.array(pageUpdateItem).min(1).max(200) }).strict();
type UpdateInput = z.infer<typeof updateInput>;

export const updatePagesManyTool: ToolDefinitionWithHandler<UpdateInput> = {
  name: "update_pages_many",
  description:
    "Edit page metadata — the ONE tool for it, for 1 page or 200 (pass a single-item `updates` array for one page; there is no separate rename/retitle/reslug tool). " +
    "Use for 'rename this page', 'change the browser-tab title', 'move this to /pricing', 'archive all draft posts', 'move these pages to the {tpl} template'. " +
    "**A page has THREE independently-editable identifiers — never substitute one for another:** " +
    "`name` = the internal editor label (page picker / breadcrumbs; not public), " +
    "`title` = the HTML <title> tag (browser tab + search results), " +
    "`slug` = the URL path. If the operator just says 'rename' without saying which, ASK before guessing — 'rename' usually means `name`. " +
    "**Changing `slug` moves the page's public URL**: a 301 from the old URL is created automatically and every nav-menu / link-list / module link pointing at it is rewritten, in one transaction. " +
    "Pass `redirectFromOld: 'skip'` ONLY when the operator explicitly says the old URL should 404 — the default keeps inbound links alive. " +
    "Per-item failures (not-found, version conflict) are reported; the rest of the batch still applies. " +
    "DO NOT use for SEO sidecar (`pages_seo.set_many`) or modules (`update_modules_many`) — those have their own bulk tools.",
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
                "URL path. Changing it auto-creates a 301 from the old URL and rewrites links pointing at it.",
            },
            templateId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["draft", "published", "archived"] },
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
    const v = r.value as { updated: number; notFound: number; conflicts: string[] };
    const conflictMsg = v.conflicts.length > 0 ? `, conflicts on: ${v.conflicts.join(", ")}` : "";
    return {
      ok: true,
      content: `Updated ${v.updated} pages (notFound=${v.notFound}${conflictMsg}).`,
    };
  },
};

// ─── update_modules_many ─────────────────────────────────────────────

const moduleUpdateItem = z
  .object({
    moduleId: uuid,
    displayName: z.string().min(1).max(256).optional(),
    html: z.string().optional(),
    css: z.string().optional(),
    js: z.string().optional(),
  })
  .strict();
const moduleUpdateInput = z.object({ updates: z.array(moduleUpdateItem).min(1).max(200) }).strict();
type ModuleUpdateInput = z.infer<typeof moduleUpdateInput>;

export const updateModulesManyTool: ToolDefinitionWithHandler<ModuleUpdateInput> = {
  name: "update_modules_many",
  description:
    "Bulk module body edits across 1–200 modules in one tool call. " +
    "Use when the operator says 'change the CTA in these 5 hero modules', 'fix the typo across these footer modules', " +
    "'apply this CSS tweak to all card modules'. " +
    "Each item is the same shape as `edit_module` (moduleId + optional displayName/html/css/js); per-item failures " +
    "are reported but the rest of the batch still applies. " +
    "Prefer this over multiple `edit_module` calls when targeting > 1 module. Each updated module emits its own " +
    "snapshot, so revert_module (or revert_site) can undo the lot.",
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
            html: { type: "string" },
            css: { type: "string" },
            js: { type: "string", description: MODULE_JS_CONTRACT },
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
    const v = r.value as { updated: number; notFound: number; failed: string[] };
    const failMsg = v.failed.length > 0 ? `, failed on: ${v.failed.join(", ")}` : "";
    return {
      ok: true,
      content: `Updated ${v.updated} modules (notFound=${v.notFound}${failMsg}).`,
    };
  },
};
