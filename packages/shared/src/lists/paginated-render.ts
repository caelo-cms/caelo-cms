// SPDX-License-Identifier: MPL-2.0

/**
 * Rendering the pages of a paginated overview (#1257, `docs/lists.md` §6
 * "Pagination"). The static generator renders every page of the
 * sequence; the editor preview renders the one asked for. Both go
 * through these helpers so they agree on when a page renders twice.
 *
 * Why a page may render twice: the page count is known only once the
 * paginated list resolved. A pager placed ABOVE the list (or in a module
 * rendered earlier) asks for it first; the render then flags
 * `pagerEarly` and the page renders again with the count it found.
 * Follow-up pages always render with the count, so only page 1 can need
 * the second pass.
 */

import type { ListRenderDeps } from "./render-data.js";
import type { ListPageContext } from "./resolve.js";

/** Which page of the sequence a render shows, and how many there are. */
export interface PaginationRequest {
  readonly page: number;
  readonly pageCount: number;
}

/** What a page render must expose for these helpers. */
export interface PaginatedRender {
  readonly lists: ListPageContext;
}

/**
 * Render page 1 of a page: once, or twice when its pager rendered before
 * the paginated list and there is more than one page.
 */
export function renderFirstPage<R extends PaginatedRender>(
  render: (pagination?: PaginationRequest) => R,
): R {
  const first = render();
  const state = first.lists.pagination();
  if (state?.pagerEarly && state.pageCount > 1) {
    return render({ page: 1, pageCount: state.pageCount });
  }
  return first;
}

/** Render every page of the sequence, page 1 first (one entry for an unpaginated page). */
export function renderEveryPage<R extends PaginatedRender>(
  render: (pagination?: PaginationRequest) => R,
): R[] {
  const first = renderFirstPage(render);
  const state = first.lists.pagination();
  const out = [first];
  if (state === null) return out;
  for (let n = 2; n <= state.pageCount; n += 1) {
    out.push(render({ page: n, pageCount: state.pageCount }));
  }
  return out;
}

/**
 * The render dependencies of a whole page sequence: an overview depends
 * on what any of its pages read (`render-deps.json` keeps one entry per
 * page id, follow-up pages included).
 */
export function mergeListRenderDeps(all: readonly ListRenderDeps[]): ListRenderDeps {
  const queries = new Map<string, ListRenderDeps["queries"][number]>();
  for (const d of all) for (const q of d.queries) queries.set(JSON.stringify(q), q);
  const union = (pick: (d: ListRenderDeps) => readonly string[]): string[] =>
    [...new Set(all.flatMap(pick))].sort();
  return {
    lists: union((d) => d.lists),
    listTypes: union((d) => d.listTypes),
    queries: [...queries.values()],
    pageTree: all.some((d) => d.pageTree),
    pages: union((d) => d.pages),
  };
}
