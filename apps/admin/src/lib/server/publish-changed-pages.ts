// SPDX-License-Identifier: MPL-2.0

/**
 * Which pages a kind-filtered Publish live re-bakes (`?/publishToProduction`
 * on /edit): the pages `snapshots.publish_impact_pages` names for the
 * checked kinds, plus the chat's direct page and page-layout edits when
 * "pages" is checked.
 *
 * A full-site impact (e.g. a content instance a shared list shows, #627)
 * wins over that union: a filtered rebuild would leave every other page
 * that renders the list stale.
 *
 * @returns the page ids to pass as `changedPageIds`, or `undefined` for a
 *   full rebuild (also when nothing was collected, so the deploy is never
 *   an empty diff).
 */
export function publishChangedPages(args: {
  readonly impact: { readonly pageIds: readonly string[]; readonly fullSite: boolean } | null;
  readonly pagesChecked: boolean;
  readonly editedPageIds: readonly string[];
  readonly editedPageLayoutPageIds: readonly string[];
}): string[] | undefined {
  if (args.impact?.fullSite) return undefined;
  const all = new Set<string>(args.impact?.pageIds ?? []);
  if (args.pagesChecked) {
    for (const id of args.editedPageIds) all.add(id);
    for (const id of args.editedPageLayoutPageIds) all.add(id);
  }
  return all.size > 0 ? [...all] : undefined;
}
