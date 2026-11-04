// SPDX-License-Identifier: MPL-2.0
const CATEGORY_LABEL = {
    performance: "Performance",
    accessibility: "Accessibility",
    "best-practices": "Best Practices",
    seo: "SEO",
};
function keyOf(row) {
    if (row.kind === "score") {
        const c = row.category ?? "";
        return {
            key: `score:${c}`,
            label: `${CATEGORY_LABEL[c] ?? c} score below 100`,
            siteWide: false,
        };
    }
    const id = row.auditId ?? "";
    if (row.kind === "finding") {
        return { key: `finding:${id}`, label: `Lighthouse ${id}`, siteWide: false };
    }
    return row.pageId === null
        ? { key: `check-site:${id}`, label: id, siteWide: true }
        : { key: `check:${id}`, label: id, siteWide: false };
}
/** What one row accepted on its page ("score 87", "up to 3 errors"). */
export function acceptedValue(row) {
    if (row.kind === "check")
        return `up to ${row.acceptedCount ?? 0} error(s)`;
    if (row.acceptedScore === null)
        return "as recorded";
    return `score ${row.acceptedScore}`;
}
/**
 * Live acceptances grouped by what they accepted; biggest group first.
 * Revoked rows are left out (they are history, listed separately).
 */
export function groupLiveAcceptances(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (row.revokedAt !== null)
            continue;
        const { key, label, siteWide } = keyOf(row);
        let g = groups.get(key);
        if (!g) {
            g = { key, label, kind: row.kind, siteWide, rows: [] };
            groups.set(key, g);
        }
        g.rows.push(row);
    }
    return [...groups.values()]
        .map((g) => ({
        ...g,
        reasons: [...new Set(g.rows.map((r) => r.reason))],
        values: [...new Set(g.rows.map(acceptedValue))],
    }))
        .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}
