// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `autofill_page_seo_many`: the first meta description of 1..N pages
 * (the former singular autofill_page_seo is its n=1 case; retired-tools.ts
 * maps old calls here). Fill-once contract: refuses a DIFFERENT text for a
 * page whose SEO was already autofilled; the same text again is a no-op the
 * result names. The AI writes every new page's meta description with it
 * before the page's first Stage — staging and production builds refuse
 * pages without one (deploy/missing-seo.ts), so this is the step that
 * unblocks them.
 */

import { autofillPageSeoToolInput } from "@caelo-cms/shared";
import { makeBulkTool } from "./_make-bulk-tool.js";
import { pageSeoWrites, withPluginWrites } from "./_plugin-write-hints.js";
import { stageReadinessSuffix } from "./_stage-readiness.js";

const autofillPageSeoManyBase = makeBulkTool({
  name: "autofill_page_seo_many",
  description: [
    "Write pages' FIRST meta description (+ optional og:image), one transaction. A Stage refuses pages without one -> run after building, before Staging.",
    "DO NOT USE FOR: pages created with `build_page` -> pass `page.metaDescription` there; changing a filled description -> `bulk_optimize_seo` (only when the user asks) or `set_page_seo_many` (exact user-dictated value).",
    "CORE RULES:",
    "- Write each from the page's actual content, 150–160 chars for a human reading a search result: read core texts with ONE `get_page_seo({pageIds})`, never by rendering; or carry over the source description when migrating. Title 50–60 chars via `update_pages_many`.",
    "- Fill-once: same text again = no-op; a DIFFERENT text for a filled field (AlreadyAutofilled / AlreadyFilled) aborts the whole batch -> leave such pages out.",
    "Writes this chat's draft: live only after Stage + the operator's Publish live (undo drops it).",
  ].join("\n"),
  itemInputSchema: autofillPageSeoToolInput,
  itemJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "metaDescription"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      metaDescription: { type: "string", minLength: 1, maxLength: 320 },
      ogImageAssetId: { type: ["string", "null"], format: "uuid" },
      seoTitle: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description:
          "Own `<title>`, only when `get_page_seo` shows the template title does not fit this page; usually leave out (the template renders).",
      },
      ogTitle: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Own og:title, only when the share title must differ from the SEO title.",
      },
      ogDescription: {
        type: "string",
        minLength: 1,
        maxLength: 320,
        description: "Own og:description, only when it must differ from the meta description.",
      },
    },
  },
  opName: "pages_seo.autofill_many",
  resultSuffix: stageReadinessSuffix,
  formatResult: (value, input) => {
    const results = (value as { results: { alreadyFilled?: boolean }[] }).results;
    const unchanged = results.flatMap((r, i) =>
      r.alreadyFilled ? [input.items[i]?.pageId ?? `items[${i}]`] : [],
    );
    const filled = results.length - unchanged.length;
    return unchanged.length === 0
      ? `SEO autofilled on ${filled} page(s).`
      : `SEO autofilled on ${filled} page(s); ${unchanged.length} already had exactly this meta description — nothing changed: ${unchanged.join(", ")}.`;
  },
});

/** The tool, with the plugins' hints on the SEO texts it filled (epic #1751). */
export const autofillPageSeoManyTool = withPluginWrites(autofillPageSeoManyBase, (input) =>
  pageSeoWrites(input.items),
);
