// SPDX-License-Identifier: MPL-2.0

/**
 * Bulk variant of `set_page_seo` — sets per-page SEO fields on N pages in one
 * transaction. Built from the `makeBulkTool` factory; dispatches
 * `pages_seo.set_many`. All-or-nothing: any invalid item aborts the whole batch.
 */

import { setPageSeoToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

export const setPageSeoManyTool = makeBulkTool({
  name: "set_page_seo_many",
  description:
    "Manually set per-page SEO fields on SEVERAL pages in ONE transaction — prefer this over multiple `set_page_seo` calls whenever you touch more than one page (§11 bulk-first). All-or-nothing: any invalid item aborts the whole batch and nothing is written. " +
    "Same rules as the singular tool: use ONLY for explicit user instructions; DON'T use for first-publish auto-fill (`autofill_page_seo`) or keyword re-optimization (`optimize_page_seo`); routine content edits MUST NOT touch SEO. " +
    "Each item is the `set_page_seo` shape: `{pageId, metaDescription?, ogImageAssetId?, canonicalUrl?, noindex?, changefreq?, priority?}`.",
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
