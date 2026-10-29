// SPDX-License-Identifier: MPL-2.0

/**
 * #1257 — page lists a build cut at the query cap.
 *
 * A page query or the term_pages source shows at most 50 pages
 * (`LIST_QUERY_MAX_LIMIT`). When more pages match, the static generator
 * reports the list (`GenerateResult.truncatedLists`) instead of cutting
 * it silently (CLAUDE.md §2): an overview of 63 guides that shows 50 is
 * incomplete, and paginating the field (`paginate`) lists all of them on
 * follow-up pages. A list cut by a smaller `limit` someone chose ("latest
 * 3 news") is a teaser, not a problem, and is not reported here —
 * `preview_list_source` still shows its total.
 *
 * Like unpublished links (#724): the shape at the generator → admin
 * boundary and the sentence every Stage surface shows. A warning; it
 * never blocks.
 */

import { z } from "zod";

/** One list a page shows cut at the cap (generator output). */
export const truncatedListSchema = z
  .object({
    pageSlug: z.string(),
    pagePath: z.string(),
    /** The module field (or a list's source node field) that rendered it. */
    field: z.string(),
    shown: z.number().int(),
    total: z.number().int(),
    limit: z.number().int(),
  })
  .strict();
export type TruncatedListReport = z.infer<typeof truncatedListSchema>;

/** How many lists a warning names (the count is always exact). */
export const TRUNCATED_LISTS_LISTED = 10;

/**
 * One sentence naming the cut lists and the next step, or null when
 * there are none. Worded for both the operator and the AI.
 */
export function describeTruncatedLists(lists: readonly TruncatedListReport[]): string | null {
  if (lists.length === 0) return null;
  const listed = lists
    .slice(0, TRUNCATED_LISTS_LISTED)
    .map((l) => `${l.pagePath} "${l.field}" shows ${l.shown} of ${l.total}`)
    .join(", ");
  const more =
    lists.length > TRUNCATED_LISTS_LISTED
      ? ` and ${lists.length - TRUNCATED_LISTS_LISTED} more`
      : "";
  return (
    `${lists.length} page list(s) are cut at ${lists[0]?.limit ?? 50} entries, so some matching pages appear nowhere in them: ${listed}${more}. ` +
    "If the list is an overview, paginate the field (update_modules_many: paginate on the list field, plus a pager) so every page is listed on follow-up pages; narrow the query if it should show fewer."
  );
}
