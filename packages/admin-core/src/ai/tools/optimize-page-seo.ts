// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `optimize_page_seo`. Explicit re-optimization with optional
 * user-supplied context (keyword analysis, intent shifts, branding
 * changes). The `seo-optimize` skill calls this for one or N pages
 * in a single chat turn; the resulting changes batch into one
 * Publish-pill confirm.
 */

import { execute } from "@caelo/query-api";
import { optimizePageSeoToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const optimizePageSeoTool: ToolDefinitionWithHandler<
  import("@caelo/shared").OptimizePageSeoToolInput
> = {
  name: "optimize_page_seo",
  description:
    "Explicit re-optimization of per-page meta description (and optional og:image). " +
    "Use ONLY when the user explicitly asks to optimize / re-write SEO and provides context " +
    "(keyword research, intent shift, branding update). Always allowed regardless of fill state. " +
    "When the user asks to optimize across multiple pages, call this once per page in the same turn — " +
    "the changes batch into one Publish-pill preview. " +
    "Don't use for first-publish auto-fill — that's `autofill_page_seo`.",
  schema: optimizePageSeoToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "metaDescription"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      metaDescription: { type: "string", minLength: 1, maxLength: 320 },
      ogImageAssetId: { type: ["string", "null"], format: "uuid" },
      context: { type: "string", maxLength: 4000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.optimize", input);
    if (!r.ok) {
      return { ok: false, content: `pages_seo.optimize failed: ${describeError(r.error)}` };
    }
    return { ok: true, content: `SEO optimized on page ${input.pageId}` };
  },
};
