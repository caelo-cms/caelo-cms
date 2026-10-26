// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_page_seo_many — manual per-page SEO sidecar writes for 1..N
 * pages in one transaction (the former singular set_page_seo is its n=1
 * case; retired-tools.ts maps old calls here). Built from the `makeBulkTool`
 * factory; dispatches `pages_seo.set_many`. It does NOT bump the
 * autofill/optimize fingerprints (CLAUDE.md §2 SEO fill-once rule).
 */

import { setPageSeoToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setPageSeoManyTool = makeBulkTool({
  name: "set_page_seo_many",
  description: [
    "Set per-page SEO fields to exact values — one call for 1..N pages (`items[]`), one all-or-nothing transaction. ONLY on explicit user instruction (e.g. 'set the home page meta description to X').",
    "DO NOT USE FOR: first-publish fill -> `autofill_page_seo_many`; re-optimization with keyword context -> `bulk_optimize_seo`. Routine content edits (`update_modules_many`/`add_module`) MUST NOT touch SEO fields.",
  ].join("\n"),
  itemInputSchema: setPageSeoToolInput,
  itemJsonSchema: {
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
  opName: "pages_seo.set_many",
});
