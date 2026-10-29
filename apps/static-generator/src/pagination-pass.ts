// SPDX-License-Identifier: MPL-2.0

/**
 * #1257 — the build's checks for paginated overviews (`docs/lists.md` §6
 * "Pagination"). The generator renders every page of a sequence
 * (`renderEveryPage`); these guards refuse a sequence a visitor could
 * not walk, and name the fix (CLAUDE.md §2, §11).
 */

import {
  collidesWithFollowUps,
  type ListPaginationState,
  paginationMarkers,
  type TruncatedList,
} from "@caelo-cms/shared";

/**
 * A list a page shows cut at the query cap: more pages match than any
 * limit can show. Reported with the Stage result so the editor and the
 * AI know the overview is incomplete (never cut silently).
 */
export interface TruncatedListReport extends TruncatedList {
  readonly pageSlug: string;
  readonly pagePath: string;
}

/**
 * Throw when a page's pagination cannot ship: more than one page but no
 * pager (the entries after page 1 would be unreachable), or the 404 page
 * paginated (it answers every unknown URL and has no path of its own).
 */
export function assertPaginationRenderable(
  page: { readonly page_id: string; readonly slug: string },
  state: ListPaginationState | null,
  notFoundPageId: string | null,
): void {
  if (state === null || state.pageCount <= 1) return;
  if (page.page_id === notFoundPageId) {
    throw new Error(
      `static-generator: the 404 page "${page.slug}" paginates list "${state.field}" (${state.total} entries, ${state.pageCount} pages), but the 404 page has no URL of its own for follow-up pages. ` +
        "Next step: remove paginate from that list on the 404 page (a short list with a limit), or put the overview on a page of its own.",
    );
  }
  if (paginationMarkers(state).length > 0) {
    throw new Error(
      `static-generator: page "${page.slug}" splits list "${state.field}" over ${state.pageCount} pages but renders no pager, so entries ${state.perPage + 1}–${state.total} would be unreachable. ` +
        'Next step: give the overview a pager — a list field {bind:"source", source:{kind:"system", name:"pagination"}} iterated with links to {{link}} labelled {{number}} (is_current / is_prev / is_next) — or raise paginate.per_page so everything fits on one page.',
    );
  }
}

/**
 * The refusal for overview follow-up URLs a real page occupies
 * (`/guides/page` or below), or null. Pure for tests.
 *
 * @param overviews - pages that emit follow-up pages.
 * @param pagePaths - every page path this build serves.
 */
export function followUpCollisionError(
  overviews: readonly { readonly path: string; readonly slug: string }[],
  pagePaths: readonly string[],
): string | null {
  const hits: string[] = [];
  for (const o of overviews) {
    for (const p of pagePaths) {
      if (collidesWithFollowUps(o.path, p)) hits.push(`${p} (under overview "${o.slug}")`);
    }
  }
  if (hits.length === 0) return null;
  return (
    `static-generator: ${hits.length} page(s) sit where paginated overviews put their follow-up pages (<overview path>/page/<n>/): ${hits.slice(0, 10).join(", ")}. ` +
    "Next step: rename those pages' slugs (update_pages_many), or remove paginate from the overview's list."
  );
}
