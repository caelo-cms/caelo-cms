// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `bulk_optimize_seo`: explicit re-optimization of 1..N pages' meta
 * descriptions with one shared, user-supplied `context` (keyword analysis,
 * intent shift, branding update). The former singular optimize_page_seo is
 * its n=1 case (retired-tools.ts maps old calls here, moving their per-call
 * `context` to the top level). Always allowed regardless of fill state.
 */

import { execute } from "@caelo-cms/query-api";
import { bulkOptimizeSeoToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkOptimizeSeoTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkOptimizeSeoToolInput
> = {
  name: "bulk_optimize_seo",
  description: [
    "Re-optimize meta descriptions (+ optional og:image) — one call for 1..N pages (`items[]`), one all-or-nothing transaction, with one shared `context`. Allowed regardless of fill state.",
    "USE FOR: ONLY when the user explicitly asks to optimize/rewrite SEO and gives context (keywords, intent shift, branding).",
    "DO NOT USE FOR: first-publish fill -> `autofill_page_seo_many`; an exact user-dictated value -> `set_page_seo_many`.",
    "Read current descriptions + core text with ONE `get_page_seo({pageIds})` first.",
  ].join("\n"),
  schema: bulkOptimizeSeoToolInput,
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
          required: ["pageId", "metaDescription"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            metaDescription: { type: "string", minLength: 1, maxLength: 320 },
            ogImageAssetId: { type: ["string", "null"], format: "uuid" },
          },
        },
      },
      context: {
        type: "string",
        maxLength: 4000,
        description:
          "The user's optimization brief (keywords, intent, branding), applied to every item.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.optimize_many", {
      updates: input.items,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    if (!r.ok) {
      return { ok: false, content: `pages_seo.optimize_many failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content: `SEO optimized on ${(r.value as { updated: number }).updated} page(s)`,
    };
  },
};
