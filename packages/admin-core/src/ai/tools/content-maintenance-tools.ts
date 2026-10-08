// SPDX-License-Identifier: MPL-2.0

/**
 * Content-maintenance tools the agent was missing (agent-tool parity, part
 * 2): where an image is used, a page's stored SEO, which pages still need an
 * SEO pass, repairing one page's URL after plugin data moved it, the import
 * runs and their event ledger, and the operator's pinned skills.
 *
 * All are routine (CLAUDE.md §11.A test: one tool call undoes a mistake) —
 * reads, an additive ledger append, a URL recompute that 301s the old path,
 * and a per-user preference. Each wraps an op that already admits the AI.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import {
  IMPORT_RUNS_LIST_MAX,
  importRunEventInput,
  type listImportRunsOp,
} from "../../ops/imports.js";
import type { mediaListUsagesOp } from "../../ops/media.js";
import type { pagesSeoGetOp, pagesSeoListStaleOp } from "../../ops/seo.js";
import type { listPinDefaultsOp } from "../../ops/skills/engagement.js";
import { describeError } from "./_describe-error.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

type OpValue<O extends { output: z.ZodType }> = z.infer<O["output"]>;

const uuid = z.string().uuid();

/** Wire JSON Schema generated from the Zod schema (one source of truth). */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

// ─── media + SEO reads ───────────────────────────────────────────────

export const listMediaUsagesTool = makeReadTool({
  name: "list_media_usages",
  description:
    "List the modules whose HTML embeds one media asset (by its id). " +
    "Use before replacing or deleting an image, or after regenerate_media_variants skipped a variant, to know which modules to edit. Find asset ids with find_media.",
  opName: "media.list_usages",
  input: z.object({ assetId: uuid }).strict(),
  format: (value) => {
    const mods = (value as OpValue<typeof mediaListUsagesOp>).modules;
    if (mods.length === 0) return "No module embeds this asset.";
    return mods.map((m) => `${m.slug} (${m.displayName}) id=${m.id}`).join("\n");
  },
});

export const getPageSeoTool = makeReadTool({
  name: "get_page_seo",
  description:
    "Read one page's stored SEO fields: meta description, OG image, canonical URL, noindex, sitemap changefreq/priority, and when it was autofilled / optimized. " +
    "Use before set_page_seo or optimize_page_seo so you change what is there instead of guessing; null means the page has no SEO row yet (autofill_page_seo fills it).",
  opName: "pages_seo.get",
  input: z.object({ pageId: uuid }).strict(),
  format: (value) => {
    const seo = (value as OpValue<typeof pagesSeoGetOp>).seo;
    if (!seo)
      return "No SEO row for this page yet — autofill_page_seo fills it before first publish.";
    return [
      `metaDescription: ${seo.metaDescription || "(empty)"}`,
      `ogImageAssetId: ${seo.ogImageAssetId ?? "(none)"}`,
      `canonicalUrl: ${seo.canonicalUrl ?? "(default)"}`,
      `noindex: ${seo.noindex}`,
      `sitemap: changefreq ${seo.changefreq}, priority ${seo.priority}`,
      `autofilledAt: ${seo.autofilledAt ?? "never"}; optimizedAt: ${seo.optimizedAt ?? "never"}`,
    ].join("\n");
  },
});

export const listStaleSeoPagesTool = makeListReadTool<
  Record<string, never>,
  OpValue<typeof pagesSeoListStaleOp>["pages"][number]
>({
  name: "list_stale_seo_pages",
  description:
    "List pages whose SEO was never optimized or whose meta description is empty (newest pages first) — the dashboard's 'needs SEO' tile. " +
    "Use when the operator asks which pages need SEO work; then bulk_optimize_seo (with their context) or set_page_seo_many.",
  opName: "pages_seo.list_stale",
  input: z.object({}).strict(),
  buildOpInput: (input) => ({ limit: Math.min(200, (input.offset ?? 0) + (input.limit ?? 50)) }),
  rows: (value) => (value as OpValue<typeof pagesSeoListStaleOp>).pages,
  label: "stale_seo_pages",
  columns: [
    { key: "pageId", value: (p) => p.pageId },
    { key: "slug", value: (p) => p.slug },
    { key: "title", value: (p) => p.title },
    { key: "description", value: (p) => (p.metaDescription ? "set" : "EMPTY") },
    { key: "autofilledAt", value: (p) => p.autofilledAt ?? "" },
  ],
  emptyMessage: "Every page has an optimized SEO description.",
});

// ─── URL drift repair ────────────────────────────────────────────────

const refreshPagePathInput = z
  .object({
    pageId: uuid,
    redirectFromOld: z
      .enum(["auto", "skip"])
      .optional()
      .describe("'auto' (default) 301s the old URL to the new one when it moved."),
  })
  .strict();
type RefreshPagePathInput = z.infer<typeof refreshPagePathInput>;

/** Recompute one page's composed URL and 301 the old one if it moved. */
export const refreshPagePathTool: ToolDefinitionWithHandler<RefreshPagePathInput> = {
  name: "refresh_page_path",
  description:
    "Recompute ONE page's public URL from its current data and, if it moved, 301 the old URL to the new one. " +
    "Use when a page's URL is out of date after plugin data changed its shape (e.g. a language variant was linked or unlinked) and the page still serves its old path. " +
    "Not for renaming a page (update_pages_many with a new slug does that, with redirects) and not for site-wide URL changes (propose_url_migration).",
  schema: refreshPagePathInput,
  inputSchema: jsonSchema(refreshPagePathInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.refresh_current_path",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `pages.refresh_current_path failed: ${describeError(r.error)}` };
    }
    const v = r.value as { path: string; moved: boolean };
    return {
      ok: true,
      content: v.moved
        ? `Page URL is now ${v.path}${input.redirectFromOld === "skip" ? "" : " (the old URL 301s to it)"}.`
        : `Page URL unchanged: ${v.path}. (In a chat, a live page's URL moves only when the chat is published.)`,
      value: v,
    };
  },
};

// ─── import runs ─────────────────────────────────────────────────────

const runStatusFilter = z.enum(["proposed", "crawling", "ready_for_review", "completed", "failed"]);

export const listImportRunsTool = makeListReadTool<
  { status?: z.infer<typeof runStatusFilter> },
  OpValue<typeof listImportRunsOp>["runs"][number]
>({
  name: "list_import_runs",
  description:
    "List site-import (migration) runs, newest first: id, source URL, status, pages seen / extracted, and errors. " +
    "Use to find a run id you did not propose yourself in this chat, or to check whether an approved crawl finished. Detail per run: get_import_run_report.",
  opName: "imports.list",
  input: z.object({ status: runStatusFilter.optional() }).strict(),
  buildOpInput: (input) => (input.status ? { status: input.status } : {}),
  serverPaging: { maxLimit: IMPORT_RUNS_LIST_MAX },
  rows: (value) => (value as OpValue<typeof listImportRunsOp>).runs,
  label: "import_runs",
  columns: [
    { key: "id", value: (r) => r.id },
    { key: "createdAt", value: (r) => r.createdAt },
    { key: "status", value: (r) => r.status },
    { key: "sourceUrl", value: (r) => r.sourceUrl },
    { key: "pages", value: (r) => `${r.pagesExtracted}/${r.pagesSeen}` },
    { key: "error", value: (r) => r.errorMessage ?? "" },
  ],
  emptyMessage: "No import runs (for that status).",
});

const logImportEventsInput = z
  .object({ events: z.array(importRunEventInput).min(1).max(500) })
  .strict();
type LogImportEventsInput = z.infer<typeof logImportEventsInput>;

/** Bulk append to import-run ledgers (imports.log_events, one transaction). */
export const logImportEventsTool: ToolDefinitionWithHandler<LogImportEventsInput> = {
  name: "log_import_events",
  description:
    "Record findings in an import run's event ledger (the migration report the operator reads): skipped assets, fidelity gaps, inventory mismatches, compose problems. " +
    "Each event: runId, severity (info / warning / error), optional phase (crawl | media | fidelity | inventory | compose | …), message, optional structured detail and pageId. " +
    "Send ALL findings of a step in ONE call (up to 500, across runs) — they insert together or not at all. For notes on one imported page use add_import_page_notes.",
  schema: logImportEventsInput,
  inputSchema: jsonSchema(logImportEventsInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.log_events", input);
    if (!r.ok) {
      return { ok: false, content: `imports.log_events failed: ${describeError(r.error)}` };
    }
    const n = (r.value as { inserted: number }).inserted;
    return { ok: true, content: `Logged ${n} event(s) to the import ledger.`, value: r.value };
  },
};

// ─── pinned skills (the operator's preference) ──────────────────────

export const listSkillPinDefaultsTool = makeReadTool<Record<string, never>>({
  name: "list_skill_pin_defaults",
  description:
    "List the skills the operator has pinned to engage in every new chat. Read before set_skill_pin_defaults (which replaces the whole list).",
  opName: "skills.list_pin_defaults",
  input: z.object({}).strict(),
  format: (value) => {
    const pins = (value as OpValue<typeof listPinDefaultsOp>).pinDefaults;
    if (pins.length === 0) return "No pinned skills.";
    return pins.map((p) => `${p.slug} (${p.displayName})`).join("\n");
  },
});

const setSkillPinDefaultsInput = z
  .object({
    slugs: z
      .array(z.string().min(1).max(120))
      .max(50)
      .describe(
        "Active skill slugs to pin. The FULL list — omitted skills are unpinned; [] clears.",
      ),
  })
  .strict();
type SetSkillPinDefaultsInput = z.infer<typeof setSkillPinDefaultsInput>;

/** Replace the operator's pinned skills; slugs resolve to active skills. */
export const setSkillPinDefaultsTool: ToolDefinitionWithHandler<SetSkillPinDefaultsInput> = {
  name: "set_skill_pin_defaults",
  description:
    "Set which skills engage automatically in every NEW chat of the operator you act for (e.g. 'always pin scoped-edit'). Replaces the whole list: read it with list_skill_pin_defaults, then send the full new list. " +
    "A per-person preference; the current chat is unaffected (load_skill engages a skill now).",
  schema: setSkillPinDefaultsInput,
  inputSchema: jsonSchema(setSkillPinDefaultsInput),
  handler: async (ctx, input, toolCtx) => {
    const list = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.list", {
      status: "active",
    });
    if (!list.ok) return { ok: false, content: `skills.list failed: ${describeError(list.error)}` };
    const active = (list.value as { skills: { id: string; slug: string }[] }).skills;
    const bySlug = new Map(active.map((s) => [s.slug, s.id]));
    const unknown = input.slugs.filter((s) => !bySlug.has(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        content: `No active skill ${unknown.map((s) => `"${s}"`).join(", ")}. Active skills: ${active.map((s) => s.slug).join(", ") || "(none)"}.`,
      };
    }
    const skillIds = [...new Set(input.slugs.map((s) => bySlug.get(s) as string))];
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "skills.set_pin_defaults", {
      skillIds,
    });
    if (!r.ok) {
      return { ok: false, content: `skills.set_pin_defaults failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content:
        skillIds.length === 0
          ? "Cleared the pinned skills."
          : `Pinned for new chats: ${[...new Set(input.slugs)].join(", ")}.`,
    };
  },
};
