// SPDX-License-Identifier: MPL-2.0

/**
 * What the live editor's page search lists (#1207). Opened without a
 * query it shows the pages changed last, then the site's first pages by
 * path, so on a small site it doubles as a page list. Typing searches the
 * whole site on the server (`/api/pages/search`, `pages.search`: the words
 * typed start words of the page's title or path, #1269) — the editor
 * never holds the site's every page. A page appears at most once: the
 * search's items are keyed by page id.
 */

/** A page as the search lists it, and as the editor opens it once picked. */
export interface SearchablePage {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published";
  readonly currentPath: string;
}

export interface PageSearchGroup {
  readonly heading: string;
  readonly pages: readonly SearchablePage[];
  /** More pages than listed: the search says to type (more). */
  readonly more: boolean;
}

/** The pages the search box knows before and while the operator types. */
export interface PageSearchSources {
  /** The pages changed last, newest first. */
  readonly recent: readonly SearchablePage[];
  /** The site's first pages (one page of `pages.list`); `more` when the site has others. */
  readonly first: { readonly pages: readonly SearchablePage[]; readonly more: boolean };
  /** The server's answer for the current query, or null while it is on its way. */
  readonly results: { readonly pages: readonly SearchablePage[]; readonly more: boolean } | null;
}

const byPath = (pages: readonly SearchablePage[]) =>
  [...pages].sort((a, b) => a.currentPath.localeCompare(b.currentPath));

/** De-duplicated by id, first occurrence kept. */
function unique(pages: readonly SearchablePage[]): SearchablePage[] {
  const seen = new Set<string>();
  return pages.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** The search's groups for `query`. */
export function pageSearchGroups(sources: PageSearchSources, query: string): PageSearchGroup[] {
  if (query.trim().length > 0) {
    const found = sources.results;
    if (!found || found.pages.length === 0) return [];
    return [{ heading: "Pages", pages: byPath(unique(found.pages)), more: found.more }];
  }
  const recent = unique(sources.recent);
  const recentIds = new Set(recent.map((p) => p.id));
  const others = byPath(unique(sources.first.pages).filter((p) => !recentIds.has(p.id)));
  return [
    ...(recent.length > 0 ? [{ heading: "Recently edited", pages: recent, more: false }] : []),
    ...(others.length > 0 || sources.first.more
      ? [
          {
            heading: recent.length > 0 ? "Other pages" : "Pages",
            pages: others,
            more: sources.first.more,
          },
        ]
      : []),
  ];
}

/** The editor's page search on the server, in the chat's view (`/api/pages/search`). */
export async function searchPages(
  query: string,
  branchId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ pages: SearchablePage[]; more: boolean }> {
  const url = `/api/pages/search?${new URLSearchParams({ q: query, branch: branchId })}`;
  const res = await fetcher(url, { signal });
  if (!res.ok) throw new Error(`The page search failed (${res.status}).`);
  return (await res.json()) as { pages: SearchablePage[]; more: boolean };
}
