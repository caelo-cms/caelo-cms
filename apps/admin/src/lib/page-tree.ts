// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 — the page hierarchy as the admin UI shows it.
 *
 * Pure helpers over the `pages.list` rows (each carries `parentPageId`):
 * depth-first tree order for the page list, and the parents a page may
 * move under (never itself, its own subtree, or the homepage — the ops
 * refuse those too; the picker just does not offer them).
 */

export interface TreeRow {
  readonly id: string;
  readonly parentPageId: string | null;
  readonly currentPath: string;
}

/**
 * Depth-first order (parents before their children, siblings by path)
 * with each row's depth (0 = top level). Rows whose parent is not in
 * the list (deleted / not visible) are treated as top level, so nothing
 * is ever hidden from the list.
 */
export function orderAsTree<T extends TreeRow>(rows: readonly T[]): { row: T; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.parentPageId !== null && ids.has(r.parentPageId) ? r.parentPageId : null;
    const list = children.get(key);
    if (list) list.push(r);
    else children.set(key, [r]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.currentPath.localeCompare(b.currentPath));
  }
  const out: { row: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ row: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Every page below `pageId` (its whole subtree), excluding itself. */
export function subtreeIds(rows: readonly TreeRow[], pageId: string): Set<string> {
  const below = new Set<string>();
  const queue = [pageId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const r of rows) {
      if (r.parentPageId === id && !below.has(r.id)) {
        below.add(r.id);
        queue.push(r.id);
      }
    }
  }
  return below;
}

/**
 * The pages `pageId` may be moved under: everything except itself, its
 * subtree and the site root ("/"). Pass `null` for a page that does not
 * exist yet (the create form).
 */
export function parentCandidates<T extends TreeRow>(
  rows: readonly T[],
  pageId: string | null,
): T[] {
  const excluded = pageId === null ? new Set<string>() : subtreeIds(rows, pageId);
  if (pageId !== null) excluded.add(pageId);
  return rows.filter((r) => !excluded.has(r.id) && r.currentPath !== "/");
}
