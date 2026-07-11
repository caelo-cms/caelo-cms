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
 */

import { execute } from "@caelo-cms/query-api";
import { type CrawlScopeEstimate, estimateCrawlScope } from "@caelo-cms/site-importer";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import { externalFetchAllowedHosts } from "./_external-fetch-budget.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const proposeSiteImportInput = z
  .object({
    sourceUrl: z.string().url(),
    depth: z.number().int().min(1).max(5).default(2),
    maxPages: z.number().int().min(1).max(2000).default(50),
  })
  .strict();

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
      : `~${e.pages} pages extrapolated from homepage links (rough)`;
  return `Scope: ${basis}; crawl ≈ ${e.crawlMinutes} min; AI rebuild ≈ $${e.aiCostUsd.low}–$${e.aiCostUsd.high}.`;
}

export const proposeSiteImportTool: ToolDefinitionWithHandler<ProposeSiteImportInput> = {
  name: "propose_site_import",
  description:
    "TWO-STEP: propose a crawl of an existing site to import pages into Caelo. " +
    "This QUEUES the proposal at /security/import/pending — Owner must Approve before " +
    "the headless crawler runs. DO NOT claim the crawl ran. Use this when the user " +
    "asks to bring an existing site into Caelo. `depth` defaults to 2 (BFS hops); " +
    "`maxPages` defaults to 50 (cap 2000). " +
    "The tool computes a page-count + cost estimate and returns it: RESTATE the scope, " +
    "duration, and cost band in your chat message BEFORE pointing at the Approve button — " +
    "the operator decides with numbers, not vibes. For large sites (hundreds of pages), " +
    "also offer a bounded pilot (homepage + one section via a small maxPages) as the " +
    "cheaper first step.",
  schema: proposeSiteImportInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourceUrl"],
    properties: {
      sourceUrl: { type: "string", format: "uri" },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      maxPages: { type: "integer", minimum: 1, maximum: 2000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const estimate = await estimator({
      sourceUrl: input.sourceUrl,
      allowedHosts: externalFetchAllowedHosts(),
    });
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.propose_run", {
      ...input,
      estimate,
    });
    if (!r.ok) {
      return { ok: false, content: `propose_site_import failed: ${describeError(r.error)}` };
    }
    const v = r.value as { runId: string };
    return {
      ok: true,
      // v0.5.11 — canonical shape so ProposeCard renders inline approve.
      content: `Queued proposal ${v.runId}: site-import ${input.sourceUrl} (depth=${input.depth ?? 2}, max=${input.maxPages ?? 50}). ${describeEstimate(estimate)} An Owner must click Approve at /security/import/pending to apply.`,
    };
  },
};
