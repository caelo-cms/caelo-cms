// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `set_page_seo`. Manual / panel-style edits to the per-page SEO
 * sidecar. Use only for explicit user intent ("set the home meta
 * description to ..."); for first-publish initialisation use
 * `autofill_page_seo`, for explicit re-optimization use
 * `optimize_page_seo`.
 */

import { execute } from "@caelo/query-api";
import { setPageSeoToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPageSeoTool: ToolDefinitionWithHandler<
  import("@caelo/shared").SetPageSeoToolInput
> = {
  name: "set_page_seo",
  description:
    "Manually set per-page SEO fields (metaDescription, ogImageAssetId, canonicalUrl, noindex, changefreq, priority). " +
    "Use ONLY for explicit user instructions like 'set the home page meta description to X'. " +
    "Don't use for first-publish auto-fill — call `autofill_page_seo`. " +
    "Don't use for explicit re-optimization with keyword context — call `optimize_page_seo`. " +
    "Routine content edits (edit_module / add_module_to_page) MUST NOT touch SEO fields.",
  schema: setPageSeoToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      metaDescription: { type: "string", maxLength: 320 },
      ogImageAssetId: { type: ["string", "null"], format: "uuid" },
      canonicalUrl: { type: ["string", "null"], maxLength: 2048 },
      noindex: { type: "boolean" },
      changefreq: {
        type: "string",
        enum: ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
      },
      priority: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.set", input);
    if (!r.ok) return { ok: false, content: `pages_seo.set failed: ${describeError(r.error)}` };
    return { ok: true, content: `SEO updated on page ${input.pageId}` };
  },
};
