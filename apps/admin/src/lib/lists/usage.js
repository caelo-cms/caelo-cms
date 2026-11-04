// SPDX-License-Identifier: MPL-2.0
/** One line: "Header navigation on 12 pages (/, /about, …)" or "Not used yet". */
export function usageSummary(usage) {
    const parts = [];
    if (usage.modules.length > 0) {
        const names = [...new Set(usage.modules.map((m) => m.displayName))];
        const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
        const pages = usage.placementCount > 0
            ? ` on ${usage.placementCount} page${usage.placementCount === 1 ? "" : "s"}`
            : "";
        parts.push(`${shown}${pages}`);
    }
    if (usage.taggedPageCount > 0) {
        parts.push(`${usage.taggedPageCount} page${usage.taggedPageCount === 1 ? "" : "s"} tagged`);
    }
    return parts.length > 0 ? parts.join(" · ") : "Not used yet";
}
