// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — which page Live Edit opens, without reading the site.
 *
 * First paint needs one page: the one in `?page=`, else the home page.
 * `pages.list` takes ids and paths (#1223), so both candidates come from
 * one bounded read. When neither exists (no home page, no usable
 * `?page=`), the editor opens the page composed at "/" in the chat's view,
 * else the site's first page (#1269: never the whole list).
 */

/** A page as the editor shows it. */
export interface EditPage {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published";
  /** #390 — the composed path; a URL plugin can prefix the slug. */
  readonly currentPath: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `pages.list` input for the `?page=` page and the home page. */
export function activePageScope(queryPage: string | null): {
  pageIds?: string[];
  paths: string[];
} {
  return queryPage && UUID_RE.test(queryPage)
    ? { pageIds: [queryPage], paths: ["/"] }
    : { paths: ["/"] };
}

/**
 * The `pages.list` input for the same two candidates in a chat's view, by id:
 * on a branch `pages.list` matches paths on the composed view, i.e. after
 * reading every page (a pending rename moves a path without touching the
 * row), so the lookup asks for the `?page=` id and main's home page id
 * instead. Null when there is neither.
 */
export function branchPageScope(
  queryPage: string | null,
  mainCandidates: readonly EditPage[],
): { pageIds: string[] } | null {
  const ids = new Set<string>();
  if (queryPage && UUID_RE.test(queryPage)) ids.add(queryPage);
  const mainHome = mainCandidates.find((p) => p.currentPath === "/");
  if (mainHome) ids.add(mainHome.id);
  return ids.size > 0 ? { pageIds: [...ids] } : null;
}

/**
 * The page a bounded lookup found: the `?page=` page, else the page at
 * `/`. Null when neither is among `rows`.
 */
export function pickScopedPage<P extends EditPage>(
  rows: readonly P[],
  queryPage: string | null,
): P | null {
  return rows.find((p) => p.id === queryPage) ?? rows.find((p) => p.currentPath === "/") ?? null;
}

/** The editor's fields of a `pages.list` row. */
export function toEditPage(p: EditPage): EditPage {
  return { id: p.id, slug: p.slug, title: p.title, status: p.status, currentPath: p.currentPath };
}
