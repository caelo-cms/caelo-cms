// SPDX-License-Identifier: MPL-2.0

/**
 * Tabs of one list in *Content → Menus & lists* (epic #1107). The
 * registry is the extension point for tabs other parts add: the
 * `international-site` plugin's "Languages" tab (part G) is one entry
 * with `requiresPlugin: "international-site"` and its own route under
 * `/content/lists/[slug]/<id>`. A tab whose plugin is not active is not
 * shown (an inactive plugin does not exist to the running system,
 * CLAUDE.md §2) — `listEditorTabs` filters on the active plugin slugs the
 * list layout loads.
 */

/** One tab of the list editor. */
export interface ListEditorTab {
  /** Route segment under `/content/lists/[slug]`; "" = the entries editor. */
  id: string;
  label: string;
  /** Shown only while this plugin is active. */
  requiresPlugin?: string;
}

/** Every tab, in display order. Add new tabs here (see the file comment). */
export const LIST_EDITOR_TABS: readonly ListEditorTab[] = [
  { id: "", label: "Entries" },
  { id: "structure", label: "Structure" },
];

/** The tabs to show for `slug`, with their hrefs. */
export function listEditorTabs(
  slug: string,
  activePlugins: ReadonlySet<string>,
  tabs: readonly ListEditorTab[] = LIST_EDITOR_TABS,
): { id: string; label: string; href: string }[] {
  return tabs
    .filter((t) => t.requiresPlugin === undefined || activePlugins.has(t.requiresPlugin))
    .map((t) => ({
      id: t.id,
      label: t.label,
      href: `/content/lists/${encodeURIComponent(slug)}${t.id ? `/${t.id}` : ""}`,
    }));
}

/** The tab `pathname` shows ("" = entries), the longest matching id. */
export function activeListTab(pathname: string, slug: string): string {
  const base = `/content/lists/${encodeURIComponent(slug)}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
  return rest.split("/")[0] ?? "";
}
