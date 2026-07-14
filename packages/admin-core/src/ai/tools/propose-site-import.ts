// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — `propose_site_import`. AI proposes a crawl; row queues at
 * `import_runs.status='proposed'`. Owner approves at
 * /security/import/pending; only then does the worker pick it up. AI
 * cannot start an unauthenticated headless crawl on its own.
 *
 * issue #193 — the tool computes a scope + cost estimate BEFORE
 * proposing (sitemap count when available, homepage-link sample
 * otherwise) and stores it on the proposal: §11.A wants the preview
 * to be a blast-radius summary, and for a migration the page count IS
 * the blast radius. Estimation runs here, not in the op handler —
 * network work stays out of the DB transaction. A failed estimate is
 * stored loudly as {failed, reason}; the proposal still lands.
 *
 * issue #298 — the scope estimator no longer prices the rebuild. THIS
 * tool prices it: pages → expected API calls → per-call context ramp →
 * tokens → the current provider/model's ai_pricing rates (see
 * ai/import-cost-model.ts for the calibrated constants and the run-15
 * telemetry behind them). When no rates row exists for the chat's
 * provider/model the band stays null with a loud costNote — the Owner
 * then approves with an explicit budget (same contract as a failed
 * scope estimate), never against an invented number.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  type CrawlScopeEstimate,
  estimateCrawlScope,
  estimateListScope,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { estimateImportAiCost, type ImportModelRates } from "../import-cost-model.js";
import { describeError } from "./_describe-error.js";
import { externalFetchAllowedHosts } from "./_external-fetch-budget.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

/** issue #229 — cap on a LIST-mode pick. A pilot samples page TYPES
 *  (one-per-type), so a couple hundred URLs is a generous ceiling; it
 *  is not a re-crawl of the whole site. */
const LIST_MODE_MAX_URLS = 200;

const proposeSiteImportInput = z
  .object({
    sourceUrl: z.string().url(),
    depth: z.number().int().min(1).max(5).optional(),
    maxPages: z.number().int().min(1).max(2000).optional(),
    /** issue #229 — LIST mode: fetch EXACTLY these absolute URLs (no BFS,
     *  no depth). Mutually exclusive with depth/maxPages. */
    urls: z.array(z.string().url()).min(1).max(LIST_MODE_MAX_URLS).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.urls && v.urls.length > 0 && (v.depth !== undefined || v.maxPages !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "list mode (`urls`) is mutually exclusive with depth crawling (`depth`/`maxPages`) — pass exactly one mode",
        path: ["urls"],
      });
    }
  });

export type ProposeSiteImportInput = z.infer<typeof proposeSiteImportInput>;

/** Test seam — estimation reaches the network. */
let estimator: typeof estimateCrawlScope = estimateCrawlScope;
export function setSiteImportEstimatorForTests(fn: typeof estimateCrawlScope | null): void {
  estimator = fn ?? estimateCrawlScope;
}

/** Human sentence for the chat + the ProposeCard. */
export function describeEstimate(est: CrawlScopeEstimate): string {
  if ("failed" in est && est.failed) {
    return `Scope estimate FAILED (${est.reason}) — the Owner will be approving a crawl of unknown size; say so.`;
  }
  const e = est as Exclude<CrawlScopeEstimate, { failed: true }>;
  const basis =
    e.basis === "sitemap"
      ? `sitemap lists ${e.pages}${e.truncated ? "+" : ""} URLs`
      : e.basis === "list"
        ? `${e.pages} chosen page${e.pages === 1 ? "" : "s"} (exact list)`
        : `~${e.pages} pages extrapolated from homepage links (rough)`;
  // issue #298 — an unpriced band is said out loud, never papered over
  // with a made-up number; the Owner then approves with an explicit budget.
  if (e.aiCostUsd === null) {
    return `Scope: ${basis}; crawl ≈ ${e.crawlMinutes} min; AI rebuild cost UNPRICED (${e.costNote ?? "no pricing available"}) — tell the Owner to set rates at /security/ai/pricing or approve with an explicit budget.`;
  }
  const modelNote =
    e.estimatedCalls !== undefined
      ? ` (models ≈${e.estimatedCalls} AI calls; low assumes prompt-cache discounts, high none)`
      : "";
  return `Scope: ${basis}; crawl ≈ ${e.crawlMinutes} min; AI rebuild ≈ $${e.aiCostUsd.low}–$${e.aiCostUsd.high}${modelNote}.`;
}

/**
 * issue #298 — price a successful scope estimate with the calls×context
 * model at the CURRENT chat provider/model's ai_pricing rates. Pure math
 * lives in ai/import-cost-model.ts; this resolves the rates. Every
 * unpriceable outcome returns the scope with `aiCostUsd: null` + a loud
 * `costNote` naming what is missing (no-fallbacks rule) — the proposal
 * still lands and the approval form demands an explicit budget instead.
 */
async function priceScopeEstimate(
  scope: Exclude<CrawlScopeEstimate, { failed: true }>,
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<CrawlScopeEstimate> {
  const unpriced = (costNote: string): CrawlScopeEstimate => ({
    ...scope,
    aiCostUsd: null,
    costNote,
  });
  const provider = toolCtx.provider;
  if (!provider) {
    return unpriced("no AI provider attached to this tool context — cannot resolve rates");
  }
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_pricing.list", {});
  if (!r.ok) {
    return unpriced(`ai_pricing lookup failed (${r.error.kind}) — cannot resolve rates`);
  }
  const rows = (
    r.value as {
      rows: Array<{
        provider: string;
        model: string;
        operationType: "text" | "image";
        inputMicrocents: number;
        outputMicrocents: number | null;
        cachedMicrocents: number | null;
      }>;
    }
  ).rows.filter((row) => row.operationType === "text" && row.provider === provider.name);
  // Exact model row wins; the provider's `*` wildcard is the stored default.
  const row = rows.find((x) => x.model === provider.model) ?? rows.find((x) => x.model === "*");
  if (!row) {
    return unpriced(
      `no ai_pricing row for ${provider.name}/${provider.model} — set rates at /security/ai/pricing`,
    );
  }
  if (row.outputMicrocents === null) {
    return unpriced(
      `ai_pricing row for ${provider.name}/${row.model} has no output rate — fix it at /security/ai/pricing`,
    );
  }
  const rates: ImportModelRates = {
    inputMicrocentsPer1K: row.inputMicrocents,
    outputMicrocentsPer1K: row.outputMicrocents,
    cachedInputMicrocentsPer1K: row.cachedMicrocents,
  };
  const est = estimateImportAiCost(scope.pages, rates);
  return {
    ...scope,
    aiCostUsd: est.aiCostUsd,
    costNote: undefined,
    estimatedCalls: est.calls,
    estimatedInputTokens: est.inputTokens,
  };
}

export const proposeSiteImportTool: ToolDefinitionWithHandler<ProposeSiteImportInput> = {
  name: "propose_site_import",
  description:
    "TWO-STEP: propose a crawl of an existing site to import pages into Caelo. " +
    "This QUEUES the proposal; the chat renders it as a card with an APPROVE button — tell the " +
    "operator to click Approve right there (the /security/import/pending page works too). The " +
    "crawler only runs after that click. DO NOT claim the crawl ran. After approval you receive " +
    "an automatic 'Approved' message; the crawl runs in the BACKGROUND — check `imports.get` for " +
    "status, and if it is still 'crawling', say so and continue when it is ready_for_review. " +
    "Use this when the user asks to bring an existing site into Caelo. " +
    "TWO MODES — pick one, never both:\n" +
    "• LIST mode — pass `urls` (array of absolute URL strings): the crawl fetches EXACTLY those " +
    "pages, nothing else. Use this when you ALREADY KNOW which pages to fetch — e.g. after " +
    "inspecting the homepage you pick one URL per apparent page type (the pilot), or you fetch a " +
    "scoped set of content pages for one type. This is the preferred pilot: it previews the " +
    "rebuild across page TYPES instead of whatever the link graph happens to expose. Name the " +
    "picked URLs in your recap so the Owner approves an informed list. Cap 200 URLs; do NOT set " +
    "`depth`/`maxPages` in this mode.\n" +
    "• DEPTH mode — pass `depth` (BFS hops, default 2, cap 5) and/or `maxPages` (default 50, cap " +
    "2000): a blind same-origin BFS that DISCOVERS pages from `sourceUrl`. Use this only when you " +
    "do NOT yet know the specific pages and want to discover the site from its root. Do NOT set " +
    "`urls` in this mode.\n" +
    "`sourceUrl` is ALWAYS required (origin + robots.txt scoping + run identity), in both modes. " +
    "The tool returns a page-count + cost estimate: RESTATE the scope, duration, and cost band in " +
    "your chat message BEFORE pointing at the Approve button — the operator decides with numbers, " +
    "not vibes.",
  schema: proposeSiteImportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceUrl"],
    properties: {
      sourceUrl: { type: "string", format: "uri" },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      maxPages: { type: "integer", minimum: 1, maximum: 2000 },
      urls: {
        type: "array",
        items: { type: "string", format: "uri" },
        minItems: 1,
        maxItems: LIST_MODE_MAX_URLS,
        description:
          "LIST mode: absolute URLs to fetch EXACTLY (no BFS). Mutually exclusive with depth/maxPages.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const listMode = !!(input.urls && input.urls.length > 0);
    // LIST mode's scope is exact — the page count IS the list length, so
    // skip the network estimator entirely; DEPTH mode samples the site.
    const scoped: CrawlScopeEstimate = listMode
      ? estimateListScope(input.urls?.length ?? 0)
      : await estimator({
          sourceUrl: input.sourceUrl,
          allowedHosts: externalFetchAllowedHosts(),
        });
    // issue #298 — price the scope with the calls×context model at the
    // current provider/model's ai_pricing rates; a failed scope stays
    // failed (nothing honest to price).
    const estimate: CrawlScopeEstimate =
      "failed" in scoped && scoped.failed
        ? scoped
        : await priceScopeEstimate(
            scoped as Exclude<CrawlScopeEstimate, { failed: true }>,
            ctx,
            toolCtx,
          );
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.propose_run", {
      ...input,
      estimate,
    });
    if (!r.ok) {
      return { ok: false, content: `propose_site_import failed: ${describeError(r.error)}` };
    }
    const v = r.value as { runId: string };
    const scope = listMode
      ? `list mode: ${input.urls?.length} specific page${input.urls?.length === 1 ? "" : "s"}`
      : `depth=${input.depth ?? 2}, max=${input.maxPages ?? 50}`;
    return {
      ok: true,
      // v0.5.11 — canonical shape so ProposeCard renders inline approve.
      content: `Queued proposal ${v.runId}: site-import ${input.sourceUrl} (${scope}). ${describeEstimate(estimate)} Approve it on the proposal card in this chat (queue: /security/import/pending).`,
    };
  },
};
