// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — `propose_site_import`. AI proposes a crawl; row queues at
 * `import_runs.status='proposed'`. Owner approves at
 * /settings/import/pending; only then does the worker pick it up. AI
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
import {
  deriveCeilingFromEstimate,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  formatMicrocentsAsMoney,
} from "../../ops/imports-cost.js";
import {
  importCrawlScopeSchema,
  refineCrawlScopeAgainstSourceUrl,
} from "../../ops/imports-crawl-scope.js";
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
    /** issue #425 — language/section scope; valid in both modes. */
    scope: importCrawlScopeSchema.optional(),
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
    refineCrawlScopeAgainstSourceUrl(v, ctx);
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
    // issue #297 — a failed estimate cannot arm a ceiling, so the approval
    // form REQUIRES an explicit budget; the AI must not promise otherwise.
    return `Scope estimate FAILED (${est.reason}) — the Owner will be approving a crawl of unknown size; say so. Approving requires entering an explicit budget on the approve form (no ceiling means no crawl).`;
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
    return `Scope: ${basis}; crawl ≈ ${e.crawlMinutes} min; AI rebuild cost UNPRICED (${e.costNote ?? "no pricing available"}) — propose the model's rates with propose_set_ai_pricing (the operator approves them in the chat), or have the Owner approve this import with an explicit budget.`;
  }
  const modelNote =
    e.estimatedCalls !== undefined
      ? ` (models ≈${e.estimatedCalls} AI calls; low assumes prompt-cache discounts, high none)`
      : "";
  // issue #297 — the shown number IS the contract: approving arms the cost
  // gate at the estimate's high bound (safety factor 1). Said here so both the
  // chat message and the ProposeCard carry the ceiling the operator agrees to.
  const derived = deriveCeilingFromEstimate(e);
  const factorNote =
    ESTIMATE_CEILING_SAFETY_FACTOR === 1
      ? "the estimate's high bound"
      : `${ESTIMATE_CEILING_SAFETY_FACTOR}× the estimate high`;
  const ceilingNote = derived.ok
    ? ` Approving arms a cost ceiling of ${formatMicrocentsAsMoney(derived.ceilingMicrocents, "USD")} automatically (${factorNote}); the run pauses and asks if real spend reaches it.`
    : "";
  return `Scope: ${basis}; crawl ≈ ${e.crawlMinutes} min; AI rebuild ≈ $${e.aiCostUsd.low}–$${e.aiCostUsd.high}${modelNote}.${ceilingNote}`;
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
      `no ai_pricing row for ${provider.name}/${provider.model} — propose its rates with propose_set_ai_pricing`,
    );
  }
  if (row.outputMicrocents === null) {
    return unpriced(
      `ai_pricing row for ${provider.name}/${row.model} has no output rate — propose the corrected row with propose_set_ai_pricing`,
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
    "Propose a crawl of an existing site to import its pages into Caelo (user wants an existing site brought in).\n" +
    "CORE RULES:\n" +
    "- TWO-STEP: QUEUES a proposal shown as an in-chat card with APPROVE (also /settings/import/pending); tell the operator to click it. The crawler runs only after the click; never claim it ran.\n" +
    "- ONE mode, never both: LIST (`urls`) | DEPTH (`depth`/`maxPages`).\n" +
    "- Result carries page count + cost estimate: RESTATE scope, duration, cost band in chat BEFORE pointing at Approve.\n" +
    "- After approval an automatic 'Approved' message arrives; the crawl runs in the BACKGROUND -> `list_import_pages({runId})`; still 'crawling' -> say so, continue at `ready_for_review` (lists each page's importPageId for the rebuild).",
  schema: proposeSiteImportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceUrl"],
    properties: {
      sourceUrl: {
        type: "string",
        format: "uri",
        description: "Both modes: origin, robots.txt scoping, run identity.",
      },
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description:
          "DEPTH mode: BFS hops from `sourceUrl` (default 2); blind same-origin discovery, only when you don't know the pages yet.",
      },
      maxPages: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        description: "DEPTH mode: page cap (default 50).",
      },
      urls: {
        type: "array",
        items: { type: "string", format: "uri" },
        minItems: 1,
        maxItems: LIST_MODE_MAX_URLS,
        description:
          "LIST mode: fetch EXACTLY these pages (no BFS). Preferred pilot: one URL per apparent page type (after inspecting the homepage) or one type's content pages -> previews the rebuild across page TYPES. Name the picked URLs in your recap.",
      },
      scope: {
        type: "object",
        additionalProperties: false,
        description:
          "ALWAYS set when migrating ONE language/section of a larger site ('migrate the German site', 'only /docs/'). At least one of pathPrefix/locale.",
        properties: {
          pathPrefix: {
            type: "string",
            description:
              'Confines the crawl, e.g. "/de/"; out-of-scope URLs reported skipped. `sourceUrl` must lie inside (crawl the scope root, e.g. https://site.com/de/).',
          },
          locale: {
            type: "string",
            description:
              "Source language, e.g. \"de\". A page naming another URL as this locale's hreflang version is skipped and that alternate crawled -> samples in the operator's language even without a path prefix.",
          },
        },
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
    const v = r.value as { runId: string; migrationBranch: boolean };
    const mode = listMode
      ? `list mode: ${input.urls?.length} specific page${input.urls?.length === 1 ? "" : "s"}`
      : `depth=${input.depth ?? 2}, max=${input.maxPages ?? 50}`;
    // issue #425 — the queued summary names the scope so the operator
    // approves a SCOPED crawl knowingly.
    const scopeNote = input.scope
      ? ` Scoped to ${[
          input.scope.pathPrefix !== undefined ? `path ${input.scope.pathPrefix}` : null,
          input.scope.locale !== undefined ? `locale ${input.scope.locale}` : null,
        ]
          .filter((s) => s !== null)
          .join(" + ")}; out-of-scope URLs will be skipped and reported.`
      : "";
    return {
      ok: true,
      // v0.5.11 — canonical shape so ProposeCard renders inline approve.
      content:
        `Queued proposal ${v.runId}: site-import ${input.sourceUrl} (${mode}).${scopeNote} ${describeEstimate(estimate)} Approve it on the proposal card in this chat (queue: /settings/import/pending).` +
        // Issue #620 — the migration builds on its own branch.
        (v.migrationBranch
          ? " This chat now works on its own migration branch: the migration stays out of the shared draft until you stage it."
          : ""),
    };
  },
};
