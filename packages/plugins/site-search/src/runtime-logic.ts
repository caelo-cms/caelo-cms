// SPDX-License-Identifier: MPL-2.0

/**
 * The search runtime's address logic without the DOM (issues #1651,
 * #1707): where a results page reads its query, and where a form in hash
 * mode sends the visitor.
 *
 * A query in the fragment (`/suche/#q=kosten`) never leaves the browser:
 * the fragment is not part of the request, so it reaches no server or CDN
 * log, and no Referer. `?q=` keeps working for sites that want it (and
 * for links into the results from elsewhere).
 *
 * Each function is self-contained (it names no import and no other
 * module-level value) because runtime.ts puts their source text into the
 * browser script: the unit tests run exactly the code visitors' browsers
 * run.
 */

/** The query a results page shows, and whether its fragment is something else. */
export interface SearchQuery {
  /** The trimmed query; "" when the address carries none. */
  readonly query: string;
  /**
   * The fragment is set but holds no `q` (`#main`, a skip link): a jump on
   * the page, not a search. A `hashchange` to it leaves the results alone.
   */
  readonly anchor: boolean;
}

/**
 * The query of an address: the fragment's `q` (`#q=…`) when the fragment
 * has one, else the query string's `q` (`?q=…`).
 *
 * @param search - `location.search` (with or without the leading `?`).
 * @param hash - `location.hash` (with or without the leading `#`).
 */
export function searchQueryOf(search: string, hash: string): SearchQuery {
  const fragment =
    String(hash || "").charAt(0) === "#" ? String(hash).slice(1) : String(hash || "");
  if (fragment !== "") {
    const fromHash = new URLSearchParams(fragment);
    if (fromHash.has("q")) return { query: String(fromHash.get("q") || "").trim(), anchor: false };
  }
  const fromSearch = new URLSearchParams(String(search || ""));
  return { query: String(fromSearch.get("q") || "").trim(), anchor: fragment !== "" };
}

/**
 * Where a form in hash mode (`data-caelo-search-mode="hash"`) sends the
 * visitor: its results page with the query in the fragment only. A `q` the
 * action itself carries is dropped, so the query is never in the request.
 * Same origin: a path (`/suche/#q=kosten`), so a search on the results page
 * itself only changes the fragment and needs no reload.
 *
 * @param action - the form's `action` attribute ("" = the current page).
 * @param base - `location.href`, against which the action resolves.
 * @param query - the visitor's query, trimmed.
 */
export function hashSearchUrl(action: string, base: string, query: string): string {
  const url = new URL(action || base, base);
  url.searchParams.delete("q");
  url.hash = new URLSearchParams({ q: query }).toString();
  if (url.origin !== new URL(base).origin) return url.href;
  return url.pathname + url.search + url.hash;
}

/** The functions runtime.ts ships, in dependency order. */
export const RUNTIME_LOGIC = [searchQueryOf, hashSearchUrl] as const;
