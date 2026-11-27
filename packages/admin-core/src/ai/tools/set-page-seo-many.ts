// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_page_seo_many — manual per-page SEO sidecar writes for 1..N
 * pages in one transaction (the former singular set_page_seo is its n=1
 * case; retired-tools.ts maps old calls here). Built from the `makeBulkTool`
 * factory; dispatches `pages_seo.set_many`. It does NOT bump the
 * autofill/optimize fingerprints (CLAUDE.md §2 SEO fill-once rule). #1752 —
 * it carries the SEO title, the Open Graph overrides, the robots directives
 * and the `data-nosnippet` placements too.
 */

import { setPageSeoToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";

/** A `max-snippet` / `max-video-preview` limit: -1 = no limit, null = no directive. */
const limit = (max: number, what: string) => ({
  type: ["integer", "null"],
  minimum: -1,
  maximum: max,
  description: `${what}; -1 = no limit, 0 = none, null = no directive.`,
});

export const setPageSeoManyTool = makeBulkTool({
  name: "set_page_seo_many",
  description: [
    "Set pages' SEO fields to exact values, all-or-nothing. ONLY on explicit user instruction (e.g. 'set the home meta description to X', 'keep the pricing table out of Google snippets').",
    "DO NOT USE FOR: first-publish fill -> `autofill_page_seo_many`; keyword re-optimization -> `bulk_optimize_seo`; one title pattern for all pages of a type -> `set_page_type_seo_many`; side effect of content edits (never touch SEO then).",
    "Read first with `get_page_seo`: each value's origin (`human` = the operator's own text, keep it unless told otherwise).",
    "Writes this chat's draft: live only after Stage + the operator's Publish live (undo drops it).",
  ].join("\n"),
  itemInputSchema: setPageSeoToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      seoTitle: {
        type: "string",
        maxLength: 200,
        description:
          "The page's own `<title>`. \"\" = none: its page type's or the site's title template renders.",
      },
      metaDescription: { type: "string", maxLength: 320 },
      ogTitle: {
        type: "string",
        maxLength: 200,
        description: 'Own og:title. "" = shares the SEO title, else the page title.',
      },
      ogDescription: {
        type: "string",
        maxLength: 320,
        description: 'Own og:description. "" = shares the meta description.',
      },
      ogImageAssetId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          "This page's own share image; null = the default (language, then site `socialShare`).",
      },
      canonicalUrl: { type: ["string", "null"], maxLength: 2048 },
      noindex: { type: "boolean", description: "Also drops the page from the sitemap." },
      nofollow: { type: "boolean" },
      noarchive: { type: "boolean", description: "No cached copy (Bing Copilot reads it too)." },
      nosnippet: {
        type: "boolean",
        description: "No text snippet; also keeps the page's text out of AI answers in search.",
      },
      noimageindex: { type: "boolean" },
      maxSnippet: limit(100000, "Most snippet characters"),
      maxImagePreview: {
        type: "string",
        enum: ["none", "standard", "large"],
        description: "Stored `large` unless set.",
      },
      maxVideoPreview: limit(86400, "Most video preview seconds"),
      nosnippetPlacements: {
        type: "array",
        maxItems: 64,
        description:
          "Placements whose text search engines must not quote (`data-nosnippet`), by block + 0-based position as `inspect_page_render` shows them. REPLACES the list; [] clears it.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["blockName", "position"],
          properties: {
            blockName: { type: "string", minLength: 1, maxLength: 128 },
            position: { type: "integer", minimum: 0 },
          },
        },
      },
      changefreq: {
        type: "string",
        enum: ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
      },
      priority: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  opName: "pages_seo.set_many",
});
