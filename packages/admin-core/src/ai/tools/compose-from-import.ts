// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: compose_from_import. P19 — synthesises a Caelo-shaped site
 * from a completed import run in one tool call.
 *
 * Use when an `import_runs` row has reached `status='ready_for_review'`
 * and the user (or the wizard at /ramp-up) wants the AI to materialise
 * the staged data into real drafts. The op aggregates extracted theme
 * tokens (color/font/etc) and writes them to `theme/site`, creates a
 * template bound to the site's default layout, and turns every staged
 * `import_pages` row into a `pages` row + modules + page_modules.
 *
 * Result: drafts that the Owner reviews via the standard `/edit` and
 * publish flow — nothing goes live automatically.
 *
 * Use AFTER the worker has finished crawling (status MUST be
 * `ready_for_review` or `completed`). For a fresh import propose the
 * crawl with `propose_site_import`, wait for Owner approval + worker
 * completion, then call this.
 */

import { execute } from "@caelo-cms/query-api";
import { composeFromImportToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const composeFromImportTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ComposeFromImportToolInput
> = {
  name: "compose_from_import",
  description:
    "Materialise a completed import run into drafts: aggregates extracted theme tokens, creates a template bound to the default layout, and turns every staged page into a draft page + modules. " +
    "Use ONLY after the import worker has run (status='ready_for_review' or 'completed'). For a brand-new import, call `propose_site_import` first — that queues the crawl + waits for Owner approval. " +
    "If the run is still crawling this returns SUCCESS with a 'still crawling' message (NOT an error) — that is expected timing: poll `imports.get` and call compose again once the run reads ready_for_review. A genuine error only comes back when the run FAILED or does not exist. " +
    "Idempotent: re-running on the same runId skips already-accepted pages.",
  schema: composeFromImportToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: { type: "string", format: "uuid" },
      templateSlug: { type: "string", minLength: 1, maxLength: 120 },
      includeImportPageIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.compose_from_run",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `imports.compose_from_run failed: ${describeError(r.error)}` };
    }
    const result = r.value as
      | { status: "crawling"; runStatus: "crawling" | "proposed"; retryAfterMs: number }
      | {
          status: "composed";
          themeTokensApplied: number;
          designTokenSource: "sampled" | "extractor" | "none";
          layoutId: string;
          templateId: string;
          templatesByCluster: Record<string, string>;
          pageIds: string[];
          homepageId: string | null;
          skippedAlreadyAccepted: number;
          skippedPages: Array<{ slug: string; sourceUrl: string; reason: string }>;
          designInventory: string | null;
          redirectsCreated: number;
          chromeBound: string[];
          chromeNotes: string[];
          tokenNotes: string[];
        };
    // Still-crawling is EXPECTED timing, not a failure — return ok so the
    // model keeps polling `imports.get` instead of showing a red card.
    if (result.status === "crawling") {
      return {
        ok: true,
        content:
          `The import crawl is still running (status=${result.runStatus}) — it has not reached ready_for_review yet. ` +
          `Do NOT treat this as an error. Wait ~${Math.round(result.retryAfterMs / 1000)}s, check \`imports.get\`, and call compose again the moment the run reads ready_for_review.`,
      };
    }
    const v = result;
    const clusterList = Object.entries(v.templatesByCluster)
      .map(([k, id]) => `${k}→${id.slice(0, 8)}`)
      .join(", ");
    return {
      ok: true,
      content: [
        `composed import run: theme=${v.themeTokensApplied} tokens, layout=${v.layoutId}, ${Object.keys(v.templatesByCluster).length} template(s) by cluster [${clusterList}], pages=${v.pageIds.length} created, redirects=${v.redirectsCreated} (old URLs 301 to the new paths)${v.skippedAlreadyAccepted > 0 ? ` (${v.skippedAlreadyAccepted} already accepted, skipped)` : ""}${v.homepageId ? `, homepage=${v.homepageId}` : ""}.`,
        // issue #247 — tell the model where the theme values came from
        // so it trusts sampled ground truth instead of guessing.
        v.designTokenSource === "sampled"
          ? "Theme tokens came from COMPUTED-STYLE SAMPLES of the rendered source pages (design ground truth, issue #247) — the applied colors, fonts and radii are what the source site actually painted. Use them as-is for theme decisions; do not invent replacement colors or fonts. Per-page samples are on each import page (sampledDesignTokens via imports.get); the site aggregate is in the run report."
          : v.designTokenSource === "extractor"
            ? "Theme tokens came from the inline-CSS extractor only (fetch-only crawl — no rendered computed-style samples exist for this run). Treat them as best-effort; verify against the stored source screenshots before making theme decisions."
            : "",
        v.chromeBound.length > 0
          ? `Site chrome bound at the LAYOUT (issue #253): ${v.chromeBound.join(" + ")} — one shared module each, rendered on every page. Edit via layout tools, never per page.`
          : "",
        v.chromeNotes.length > 0
          ? `Chrome notes (surface these to the operator, do not work around them silently): ${v.chromeNotes.join(", ")}.`
          : "",
        // Pages held back by a per-page gate (unacknowledged screenshot
        // fail). Never a silent drop — name them so the operator can
        // acknowledge or exclude and re-run.
        v.skippedPages.length > 0
          ? `Pages SKIPPED (surface these — do not claim they were built): ${v.skippedPages.map((p) => `'${p.slug}' — ${p.reason}`).join(" | ")}`
          : "",
        // Run #8 — crawled vars the theme layer refused (e.g. WP preset
        // font SIZES that are not font families). Loud, never silent.
        v.tokenNotes.length > 0
          ? `Theme-token skips (crawled values the theme layer refused — relay to the operator, do not re-add them): ${v.tokenNotes.join(", ")}.`
          : "",
        v.designInventory
          ? `Original design fact base (issue #195 — use it for your theme decisions, then verify with the stored screenshots):\n${v.designInventory}`
          : "",
      ]
        .filter((x) => x.length > 0)
        .join("\n"),
    };
  },
};
