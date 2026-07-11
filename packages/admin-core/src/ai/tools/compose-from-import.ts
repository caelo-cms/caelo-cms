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
    const v = r.value as {
      themeTokensApplied: number;
      layoutId: string;
      templateId: string;
      templatesByCluster: Record<string, string>;
      pageIds: string[];
      homepageId: string | null;
      skippedAlreadyAccepted: number;
      designInventory: string | null;
    };
    const clusterList = Object.entries(v.templatesByCluster)
      .map(([k, id]) => `${k}→${id.slice(0, 8)}`)
      .join(", ");
    return {
      ok: true,
      content: [
        `composed import run: theme=${v.themeTokensApplied} tokens, layout=${v.layoutId}, ${Object.keys(v.templatesByCluster).length} template(s) by cluster [${clusterList}], pages=${v.pageIds.length} created${v.skippedAlreadyAccepted > 0 ? ` (${v.skippedAlreadyAccepted} already accepted, skipped)` : ""}${v.homepageId ? `, homepage=${v.homepageId}` : ""}.`,
        v.designInventory
          ? `Original design fact base (issue #195 — use it for your theme decisions, then verify with the stored screenshots):\n${v.designInventory}`
          : "",
      ]
        .filter((x) => x.length > 0)
        .join("\n"),
    };
  },
};
