// SPDX-License-Identifier: MPL-2.0
/** Every tab, in display order. Add new tabs here (see the file comment). */
export const LIST_EDITOR_TABS = [
    { id: "", label: "Entries" },
    { id: "structure", label: "Structure" },
    // Epic #1107 part G — what each entry shows in each language.
    { id: "languages", label: "Languages", requiresPlugin: "international-site" },
];
/** The tabs to show for `slug`, with their hrefs. */
export function listEditorTabs(slug, activePlugins, tabs = LIST_EDITOR_TABS) {
    return tabs
        .filter((t) => t.requiresPlugin === undefined || activePlugins.has(t.requiresPlugin))
        .map((t) => ({
        id: t.id,
        label: t.label,
        href: `/content/lists/${encodeURIComponent(slug)}${t.id ? `/${t.id}` : ""}`,
    }));
}
/** The tab `pathname` shows ("" = entries), the longest matching id. */
export function activeListTab(pathname, slug) {
    const base = `/content/lists/${encodeURIComponent(slug)}`;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
    return rest.split("/")[0] ?? "";
}
