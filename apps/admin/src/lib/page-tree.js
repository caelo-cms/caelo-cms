// SPDX-License-Identifier: MPL-2.0
/**
 * Depth-first order (parents before their children, siblings by path)
 * with each row's depth (0 = top level). Rows whose parent is not in
 * the list (deleted / not visible) are treated as top level, so nothing
 * is ever hidden from the list.
 */
export function orderAsTree(rows) {
    const ids = new Set(rows.map((r) => r.id));
    const children = new Map();
    for (const r of rows) {
        const key = r.parentPageId !== null && ids.has(r.parentPageId) ? r.parentPageId : null;
        const list = children.get(key);
        if (list)
            list.push(r);
        else
            children.set(key, [r]);
    }
    for (const list of children.values()) {
        list.sort((a, b) => a.currentPath.localeCompare(b.currentPath));
    }
    const out = [];
    const seen = new Set();
    const walk = (parent, depth) => {
        for (const r of children.get(parent) ?? []) {
            if (seen.has(r.id))
                continue;
            seen.add(r.id);
            out.push({ row: r, depth });
            walk(r.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}
/** Every page below `pageId` (its whole subtree), excluding itself. */
export function subtreeIds(rows, pageId) {
    const below = new Set();
    const queue = [pageId];
    while (queue.length > 0) {
        const id = queue.shift();
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
export function parentCandidates(rows, pageId) {
    const excluded = pageId === null ? new Set() : subtreeIds(rows, pageId);
    if (pageId !== null)
        excluded.add(pageId);
    return rows.filter((r) => !excluded.has(r.id) && r.currentPath !== "/");
}
