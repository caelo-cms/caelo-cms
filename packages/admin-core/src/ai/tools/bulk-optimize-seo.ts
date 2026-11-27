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
import { describeError, toolError } from "./_describe-error.js";
import { pageSeoWrites, withPluginWrites } from "./_plugin-write-hints.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const bulkOptimizeSeoBase: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").BulkOptimizeSeoToolInput
> = {
  name: "bulk_optimize_seo",
  description: [
    "Re-optimize the SEO texts (meta description, SEO title, og:title/og:description, og:image) of 1..N pages, all-or-nothing, regardless of fill state.",
    "USE FOR: ONLY an explicit user request to optimize/rewrite SEO with context (keywords, intent, branding).",
    "DO NOT USE FOR: first-publish fill -> `autofill_page_seo_many`; exact dictated value -> `set_page_seo_many`; one title pattern for all pages of a type -> `set_page_type_seo_many`.",
    "First read current texts, their origins + core text with ONE `get_page_seo({pageIds})`. Each item names only the texts it rewrites.",
    "Writes this chat's draft: live only after Stage + the operator's Publish live (undo drops it).",
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
          required: ["pageId"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            metaDescription: { type: "string", minLength: 1, maxLength: 320 },
            seoTitle: {
              type: "string",
              maxLength: 200,
              description: 'Own `<title>`; "" = back to the title template.',
            },
            ogTitle: {
              type: "string",
              maxLength: 200,
              description: 'Own og:title; "" = shares the SEO title.',
            },
            ogDescription: {
              type: "string",
              maxLength: 320,
              description: 'Own og:description; "" = shares the meta description.',
            },
            ogImageAssetId: { type: ["string", "null"], format: "uuid" },
          },
        },
      },
      context: {
        type: "string",
        maxLength: 4000,
        description: "The user's brief, applied to every item.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.optimize_many", {
      updates: input.items,
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    if (!r.ok) {
      return toolError(r.error, `pages_seo.optimize_many failed: ${describeError(r.error)}`);
    }
    return {
      ok: true,
      content: `SEO optimized on ${(r.value as { updated: number }).updated} page(s) in this chat's draft — live after Stage + Publish live`,
    };
  },
};

/** The tool, with the plugins' hints on the SEO texts it rewrote (epic #1751). */
export const bulkOptimizeSeoTool = withPluginWrites(bulkOptimizeSeoBase, (input) =>
  pageSeoWrites(input.items),
);
