// SPDX-License-Identifier: MPL-2.0
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The `pages.list` input for the `?page=` page and the home page. */
export function activePageScope(queryPage) {
    return queryPage && UUID_RE.test(queryPage)
        ? { pageIds: [queryPage], paths: ["/"] }
        : { paths: ["/"] };
}
/**
 * The `pages.list` input for the same two candidates in a chat's view, by id:
 * on a branch `pages.list` matches paths on the composed view, i.e. after
 * reading every page (a pending rename moves a path without touching the
 * row), so the lookup asks for the `?page=` id and main's home page id
 * instead. Null when there is neither (read the whole list).
 */
export function branchPageScope(queryPage, mainCandidates) {
    const ids = new Set();
    if (queryPage && UUID_RE.test(queryPage))
        ids.add(queryPage);
    const mainHome = mainCandidates.find((p) => p.currentPath === "/");
    if (mainHome)
        ids.add(mainHome.id);
    return ids.size > 0 ? { pageIds: [...ids] } : null;
}
/**
 * The page a bounded lookup found: the `?page=` page, else the page at
 * `/`. Null when neither is among `rows` (the caller reads the whole list).
 */
export function pickScopedPage(rows, queryPage) {
    return rows.find((p) => p.id === queryPage) ?? rows.find((p) => p.currentPath === "/") ?? null;
}
/**
 * The page to open among `rows`: the `?page=` page, else the home page,
 * else the first row (only meaningful when `rows` is the whole list).
 */
export function pickActivePage(rows, queryPage) {
    return (rows.find((p) => p.id === queryPage) ??
        rows.find((p) => p.currentPath === "/") ??
        rows[0] ??
        null);
}
/** The editor's fields of a `pages.list` row. */
export function toEditPage(p) {
    return { id: p.id, slug: p.slug, title: p.title, status: p.status, currentPath: p.currentPath };
}
