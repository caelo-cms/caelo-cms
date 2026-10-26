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
    "Write the FIRST meta description (+ optional og:image) of pages — one call for 1..N pages (`items[]`), one transaction. A Stage refuses pages without one and names them, so run it after building pages and before Staging.",
    "DO NOT USE FOR: pages you create with `build_page` -> pass `page.metaDescription` there (same fill-once write, no extra call); changing a filled description -> `bulk_optimize_seo` (re-optimization, only when the user asks) or `set_page_seo_many` (an exact user-dictated value).",
    "CORE RULES:",
    "- Write each from that page's actual content, 150–160 chars for a human reading a search result: read all core texts with ONE `get_page_seo({pageIds})`, never by rendering pages; or carry over the source page's description when migrating. Title 50–60 chars via `update_pages_many`.",
    "- Fill-once: the same text again = no-op (the result says so); a DIFFERENT text for a filled page returns AlreadyAutofilled with the stored text and aborts the whole batch -> leave such pages out.",
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
