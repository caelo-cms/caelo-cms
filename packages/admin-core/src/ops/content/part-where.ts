// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a changed part (a section design, or the content of a section)
 * is a change of one page or a change that shows on many: the rule the
 * Draft changes summary and the Publish live review count by. Pure; the
 * placements are read by `loadPartPlacements` (part-placement.ts).
 *
 * Since v0.12 every placement holds its own content instance, so editing
 * the text of one section on one page is, by entity, a content-instance
 * change, and a new section design made for one page is a module change.
 * An operator recognises both as a change of that page. So:
 *
 *   - shown on exactly one page: a change of that page;
 *   - shown on no page (an unplaced section design, content nothing
 *     shows any more): nothing a visitor sees changes, so it is not listed;
 *   - shown on two or more pages, in a layout's chrome or through a
 *     shared list: a site-wide change, with where it shows.
 */

/** One page a part renders on. */
export interface PartPage {
  readonly pageId: string;
  readonly path: string;
  readonly title: string;
}

/** Where one part renders, as the caller sees the site. */
export interface PartPlacement {
  /** Pages it renders on (not deleted), by path. */
  readonly pages: readonly PartPage[];
  /** It may render on more pages than `pages` lists (more instances than were read). */
  readonly morePages: boolean;
  /** A layout's chrome shows it: it renders on every page of that layout. */
  readonly inLayout: boolean;
  /** Names of the shared lists that show it (a menu, footer links). */
  readonly lists: readonly string[];
}

/** {@link wherePartShows}: one page, none, or many. */
export type PartWhere =
  | { readonly kind: "page"; readonly page: PartPage }
  | { readonly kind: "nowhere" }
  | {
      readonly kind: "many";
      /** The pages it shows on that count (see `shown`), by path. */
      readonly pages: readonly PartPage[];
      readonly morePages: boolean;
      readonly inLayout: boolean;
      readonly lists: readonly string[];
    };

/**
 * Classify one part's placement.
 *
 * @param shown - which pages count. The Publish live review counts only
 *   the pages the staged build publishes (a draft page reaches no
 *   visitor); the Draft changes summary counts every page of the draft.
 */
export function wherePartShows(
  placement: PartPlacement,
  shown: (pageId: string) => boolean = () => true,
): PartWhere {
  const pages = placement.pages.filter((p) => shown(p.pageId));
  if (placement.inLayout || placement.lists.length > 0 || placement.morePages || pages.length > 1) {
    return {
      kind: "many",
      pages,
      morePages: placement.morePages,
      inLayout: placement.inLayout,
      lists: placement.lists,
    };
  }
  const [only] = pages;
  return only ? { kind: "page", page: only } : { kind: "nowhere" };
}

/**
 * Where a site-wide part shows, in the operator's words: "in the site
 * layout", "in the list Main menu", "on 4 pages", "on many pages".
 */
export function describeWhere(where: Extract<PartWhere, { kind: "many" }>): string {
  if (where.inLayout) return "in the site layout";
  const [list, ...more] = where.lists;
  if (list !== undefined)
    return more.length > 0 ? `in ${where.lists.length} lists` : `in the list ${list}`;
  if (where.morePages) return "on many pages";
  return `on ${where.pages.length} pages`;
}

/** The page to open to see a site-wide part: its first page, or the home page for layout chrome and lists. */
export function samplePathOf(where: Extract<PartWhere, { kind: "many" }>): string {
  return where.pages[0]?.path ?? "/";
}
