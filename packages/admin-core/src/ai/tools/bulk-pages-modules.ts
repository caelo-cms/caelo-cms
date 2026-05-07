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
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const uuid = z.string().uuid();

// ─── delete_pages_many ───────────────────────────────────────────────

const deleteInput = z.object({ pageIds: z.array(uuid).min(1).max(200) }).strict();
type DeleteInput = z.infer<typeof deleteInput>;

export const deletePagesManyTool: ToolDefinitionWithHandler<DeleteInput> = {
  name: "delete_pages_many",
  description:
    "Bulk soft-delete 1–200 pages in one tool call. " +
    "Use when the operator says 'delete these N pages', 'drop these stale posts', 'remove the entire {category} tree'. " +
    "Prefer this over multiple `delete_page` calls when N > 1 — saves tool-call rounds + lets the operator revert " +
    "the lot in one site snapshot. Each page is soft-deleted and emits its own page snapshot, so revert_site (or " +
    "individual revert_page) restores them. The result reports {deleted, alreadyDeleted, notFound}.",
  schema: deleteInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageIds"],
    properties: {
      pageIds: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "string", format: "uuid" },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.delete_many", input);
    if (!r.ok) {
      return { ok: false, content: `pages.delete_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as { deleted: number; alreadyDeleted: number; notFound: number };
    return {
      ok: true,
      content: `Deleted ${v.deleted} pages (alreadyDeleted=${v.alreadyDeleted}, notFound=${v.notFound}). Use \`propose_revert_site\` to undo if needed.`,
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
  })
  .strict();
const updateInput = z.object({ updates: z.array(pageUpdateItem).min(1).max(200) }).strict();
type UpdateInput = z.infer<typeof updateInput>;

export const updatePagesManyTool: ToolDefinitionWithHandler<UpdateInput> = {
  name: "update_pages_many",
  description:
    "Bulk metadata edits across 1–200 pages in one tool call. " +
    "Use when the operator says 'archive all draft posts', 'rename these 8 landing pages', 'move these pages to the {tpl} template'. " +
    "Each item is the same shape as `pages.update` (pageId + optional name/title/slug/templateId/status); per-item failures " +
    "(not-found, version conflict) are reported but the rest of the batch still applies. " +
    "Prefer this over multiple `rename_page` / `set_page_title` / `change_page_slug` / `change_template` calls when targeting > 1 page. " +
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
            name: { type: "string", minLength: 1, maxLength: 256 },
            title: { type: "string", minLength: 1, maxLength: 256 },
            slug: { type: "string", minLength: 1, maxLength: 120 },
            templateId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["draft", "published", "archived"] },
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
            js: { type: "string" },
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
