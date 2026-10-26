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
import {
  type pagesSeoGetManyOp,
  type pagesSeoListStaleOp,
  SEO_GET_MANY_MAX,
} from "../../ops/seo.js";
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
    "List modules whose HTML embeds one media asset (id from `find_media`). Use before replacing/deleting an image, or after `regenerate_media_variants` skipped a variant, to know which modules to edit.",
  opName: "media.list_usages",
  input: z.object({ assetId: uuid }).strict(),
  format: (value) => {
    const mods = (value as OpValue<typeof mediaListUsagesOp>).modules;
    if (mods.length === 0) return "No module embeds this asset.";
    return mods.map((m) => `${m.slug} (${m.displayName}) id=${m.id}`).join("\n");
  },
});

type SeoPage = OpValue<typeof pagesSeoGetManyOp>["pages"][number];

function formatSeoPage(p: SeoPage): string {
  const seo = p.seo;
  const fields = seo
    ? [
        `metaDescription: ${seo.metaDescription || "(empty)"}`,
        `ogImageAssetId: ${seo.ogImageAssetId ?? "(none)"}`,
        `canonicalUrl: ${seo.canonicalUrl ?? "(default)"}`,
        `noindex: ${seo.noindex}`,
        `sitemap: changefreq ${seo.changefreq}, priority ${seo.priority}`,
        `autofilledAt: ${seo.autofilledAt ?? "never"}; optimizedAt: ${seo.optimizedAt ?? "never"}`,
      ]
    : ["No SEO row for this page yet — autofill_page_seo_many fills it before first publish."];
  const textHead = p.contentTextTruncated
    ? `contentText (the first ${p.contentText.length} of ${p.contentTextLength} characters — enough to write a description from):`
    : "contentText:";
  const text =
    p.contentText.length > 0
      ? p.contentText
      : "(no text yet — the page's own blocks are empty; build its content before writing a description)";
  return [`## ${p.title} (${p.path}) pageId=${p.pageId}`, ...fields, textHead, text].join("\n");
}

const getPageSeoInput = z
  .object({
    pageId: uuid.optional().describe("Pass this OR `pageIds`."),
    pageIds: z
      .array(uuid)
      .min(1)
      .max(SEO_GET_MANY_MAX)
      .optional()
      .describe("Pass this OR `pageId`."),
  })
  .strict()
  .refine((v) => (v.pageId === undefined) !== (v.pageIds === undefined), {
    message: "pass exactly one of pageId or pageIds",
  });

export const getPageSeoTool = makeReadTool({
  name: "get_page_seo",
  description:
    "Read pages' stored SEO fields (meta description, OG image, canonical, noindex, sitemap, autofill/optimize times) AND core text (plain text of own content blocks, no header/footer chrome, this chat's draft, ~1500 chars).\n" +
    "USE FOR: reading before writing/optimizing descriptions — ALL pages in one call, then ONE `autofill_page_seo_many` (first description) or `bulk_optimize_seo`/`set_page_seo_many`.\n" +
    "DO NOT USE `inspect_page_render`/`screenshot_page` for this (layout/visual only). No SEO row -> `autofill_page_seo_many` fills it.",
  opName: "pages_seo.get_many",
  input: getPageSeoInput,
  buildOpInput: (input) => ({ pageIds: input.pageIds ?? [input.pageId] }),
  format: (value) =>
    (value as OpValue<typeof pagesSeoGetManyOp>).pages.map(formatSeoPage).join("\n\n"),
});

export const listStaleSeoPagesTool = makeListReadTool<
  Record<string, never>,
  OpValue<typeof pagesSeoListStaleOp>["pages"][number]
>({
  name: "list_stale_seo_pages",
  description:
    "List pages whose SEO was never optimized or whose meta description is empty (newest first) — the dashboard's 'needs SEO' tile. Then: empty, never-autofilled -> `autofill_page_seo_many`; re-optimize with context -> `bulk_optimize_seo`; exact values -> `set_page_seo_many`.",
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
      .describe("'auto' (default) 301s the old URL when it moved."),
  })
  .strict();
type RefreshPagePathInput = z.infer<typeof refreshPagePathInput>;

/** Recompute one page's composed URL and 301 the old one if it moved. */
export const refreshPagePathTool: ToolDefinitionWithHandler<RefreshPagePathInput> = {
  name: "refresh_page_path",
  description:
    "Recompute ONE page's URL from its current data. DRAFT page -> moves now. PUBLISHED page with outdated URL -> not moved; result reports awaiting a URL migration -> call `propose_url_migration` (Owner-approved; previews the move + writes 301s). " +
    "Linking/unlinking language variants already refreshes touched pages. Not for renaming (`update_pages_many` with a new slug).",
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
    const v = r.value as { path: string; moved: boolean; awaitingUrlMigration: boolean };
    return {
      ok: true,
      content: v.awaitingUrlMigration
        ? `Page URL unchanged: ${v.path}. Its new URL waits for an approved URL migration — call propose_url_migration (the Owner approves the move and its 301s); do not refresh pages one by one.`
        : v.moved
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
    "List site-import (migration) runs, newest first: id, source URL, status, pages seen/extracted, errors. Use to find a run id not proposed in this chat, or check whether an approved crawl finished. Per-run detail: `get_import_run_report`.",
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
    "Record findings in import-run event ledgers (the migration report the operator reads): skipped assets, fidelity gaps, inventory mismatches, compose problems. `phase` e.g. crawl|media|fidelity|inventory|compose; `detail` = optional structured data. " +
    "Send ALL findings of a step in ONE call (may span runs); all insert or none. Notes on one imported page -> `add_import_page_notes`.",
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
    "List skills pinned to engage in every new chat. Read before `set_skill_pin_defaults` (replaces the whole list).",
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
        "Active skill slugs. FULL list (read `list_skill_pin_defaults` first); omitted ones are unpinned; [] clears.",
      ),
  })
  .strict();
type SetSkillPinDefaultsInput = z.infer<typeof setSkillPinDefaultsInput>;

/** Replace the operator's pinned skills; slugs resolve to active skills. */
export const setSkillPinDefaultsTool: ToolDefinitionWithHandler<SetSkillPinDefaultsInput> = {
  name: "set_skill_pin_defaults",
  description:
    "Set which skills engage automatically in every NEW chat of the operator you act for (e.g. 'always pin scoped-edit'). Per-person; current chat unaffected (`load_skill` engages now).",
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
