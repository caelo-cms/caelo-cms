// SPDX-License-Identifier: MPL-2.0
/** How many pages a group lists; the rest are found by typing (a site can have 50k pages). */
export const MAX_MATCHES = 50;
/**
 * The search's groups for `query`.
 *
 * @param recentIds The pages changed last, newest first; ids the editor
 *   does not list (a page deleted since) are skipped.
 */
export function pageSearchGroups(pages, recentIds, query) {
    const byPath = [...pages].sort((a, b) => a.currentPath.localeCompare(b.currentPath));
    const q = query.trim().toLowerCase();
    if (q.length > 0) {
        const matches = byPath.filter((p) => p.currentPath.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
        if (matches.length === 0)
            return [];
        return [
            {
                heading: "Pages",
                pages: matches.slice(0, MAX_MATCHES),
                hidden: Math.max(0, matches.length - MAX_MATCHES),
            },
        ];
    }
    const byId = new Map(pages.map((p) => [p.id, p]));
    const recent = recentIds.flatMap((id) => byId.get(id) ?? []);
    const recentSet = new Set(recent.map((p) => p.id));
    const others = byPath.filter((p) => !recentSet.has(p.id));
    return [
        ...(recent.length > 0 ? [{ heading: "Recently edited", pages: recent, hidden: 0 }] : []),
        ...(others.length > 0
            ? [
                {
                    heading: recent.length > 0 ? "All other pages" : "All pages",
                    pages: others.slice(0, MAX_MATCHES),
                    hidden: Math.max(0, others.length - MAX_MATCHES),
                },
            ]
            : []),
    ];
}
