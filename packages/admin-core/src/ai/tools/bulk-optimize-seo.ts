// SPDX-License-Identifier: MPL-2.0

/**
 * P8 AI-first review pass — `bulk_optimize_seo`. The user supplies
 * shared context (keyword analysis, intent shift, branding update);
 * the AI assembles the per-page revisions and posts them all in one
 * tool call. The original `optimize_page_seo` description told the
 * AI to make N round-trips per turn — this replaces that pattern
 * per CLAUDE.md §11.
 */

import { execute } from "@caelo/query-api";
import { bulkOptimizeSeoToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const bulkOptimizeSeoTool: ToolDefinitionWithHandler<
  import("@caelo/shared").BulkOptimizeSeoToolInput
> = {
  name: "bulk_optimize_seo",
  description:
    "Re-optimize SEO across up to 200 pages in one transaction with shared context " +
    "(keyword research, intent shift, branding update). " +
    "Use this — NOT multiple `optimize_page_seo` calls — when the user asks to optimize 2+ pages. " +
    "Each update is { pageId, metaDescription, ogImageAssetId? }. " +
    "All-or-nothing: a single failed update rolls back the whole batch. " +
    "For a single page, use `optimize_page_seo`.",
  schema: bulkOptimizeSeoToolInput,
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
          required: ["pageId", "metaDescription"],
          properties: {
            pageId: { type: "string", format: "uuid" },
            metaDescription: { type: "string", minLength: 1, maxLength: 320 },
            ogImageAssetId: { type: ["string", "null"], format: "uuid" },
          },
        },
      },
      context: { type: "string", maxLength: 4000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages_seo.optimize_many",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `pages_seo.optimize_many failed: ${describeError(r.error)}` };
    }
    return {
      ok: true,
      content: `SEO optimized on ${(r.value as { updated: number }).updated} page(s)`,
    };
  },
};
