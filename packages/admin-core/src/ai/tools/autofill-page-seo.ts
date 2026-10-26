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
import { stageReadinessSuffix } from "./_stage-readiness.js";

export const autofillPageSeoManyTool = makeBulkTool({
  name: "autofill_page_seo_many",
  description: [
    "Write pages' FIRST meta description (+ optional og:image), one transaction. A Stage refuses pages without one -> run after building, before Staging.",
    "DO NOT USE FOR: pages created with `build_page` -> pass `page.metaDescription` there; changing a filled description -> `bulk_optimize_seo` (only when the user asks) or `set_page_seo_many` (exact user-dictated value).",
    "CORE RULES:",
    "- Write each from the page's actual content, 150–160 chars for a human reading a search result: read core texts with ONE `get_page_seo({pageIds})`, never by rendering; or carry over the source description when migrating. Title 50–60 chars via `update_pages_many`.",
    "- Fill-once: same text again = no-op; a DIFFERENT text for a filled page (AlreadyAutofilled) aborts the whole batch -> leave such pages out.",
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
