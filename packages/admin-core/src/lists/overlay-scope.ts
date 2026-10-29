// SPDX-License-Identifier: MPL-2.0

/**
 * #1223 — what one page's render can show from lists, so the editor
 * preview asks `list-resolve` for that page's overlay instead of the whole
 * site's (the plugin's answer then costs what the page costs).
 *
 * An overlay is keyed by value address (`list/<listId>/…`,
 * `instance/<ciId>/…`, `page/<pageId>/props/…`, docs/lists.md §9.3). The
 * resolver reads it lazily while the page renders, so the scope has to be
 * known before the render and has to be a SUPERSET of what the render
 * reads; anything more only costs a few rows:
 *
 *   - lists: every shared list. A list renders as a whole wherever it is
 *     bound (a menu, the site texts, a vocabulary's terms), and their
 *     number does not grow with the pages.
 *   - content instances: the instances the page renders (its placements
 *     and the instances nested in them), whose local lists the overlay
 *     translates.
 *   - pages: the rendered page (`{{page.props.*}}`) and, when a list on
 *     the page generates page entries (a query or a system source:
 *     latest news, children, breadcrumbs), every page of the page's
 *     variant that has properties. A props overlay only exists for pages
 *     of the variant the page renders, and only for page types that
 *     declare properties, so no other page can show one.
 *
 * Null when the page shows nothing a list overlay can change: no module
 * on it (placed, chrome, nested or a content variant) has a list field,
 * and no markup reads `page.*` or `site_text.*`. The preview then skips
 * `list-resolve` entirely.
 */

import type { ListRenderData, TemplateField } from "@caelo-cms/shared";

/** The `scope` of a scoped `list-resolve` call (plugin-sdk `listResolveScope`). */
export interface ListOverlayScope {
  readonly listIds: string[];
  readonly contentInstanceIds: string[];
  readonly pageIds: string[];
}

/** A module as far as the scope cares: its fields and its markup. */
export interface ScopedModule {
  readonly fields: readonly TemplateField[];
  readonly html: string;
}

/** What {@link pageListOverlayScope} reads the page from. */
export interface PageListOverlayInput {
  readonly pageId: string;
  /** The page's list render data before overlays (pages, lists, types, partition). */
  readonly data: ListRenderData;
  /** Every module the page renders: placed, chrome, nested, content variants. */
  readonly modules: Iterable<ScopedModule>;
  /** Markup outside the modules: the template's and the layout's HTML. */
  readonly markup: Iterable<string>;
  /** The stored content instances the page renders (render-local aliases excluded). */
  readonly contentInstanceIds: Iterable<string>;
}

/**
 * `{{page.…}}` / `{{site_text.…}}` (any case, any section operator). A
 * loose match on purpose: a false hit costs one scoped plugin call, a
 * miss would show the page untranslated.
 */
const LIST_SCOPE_READ_RE = /\b(?:page|site_text)\./i;

/** True when the module's markup or fields can read list data. */
function readsLists(m: ScopedModule): boolean {
  return m.fields.some((f) => f.kind === "list") || LIST_SCOPE_READ_RE.test(m.html);
}

/** True when one of `fields` can generate page entries (a query or system source). */
function generatesPages(fields: readonly TemplateField[], data: ListRenderData): boolean {
  for (const f of fields) {
    if (f.kind !== "list") continue;
    if (f.bind === "source" && f.source?.kind !== "plugin") return true;
    const type = f.listType === undefined ? undefined : data.listTypes.get(f.listType);
    if (!type) continue;
    for (const node of Object.values(type.def.nodes)) {
      if (node.source && node.source.kind !== "plugin") return true;
    }
  }
  return false;
}

/**
 * The scope of one page's `list-resolve` call, or null when the page
 * shows nothing an overlay can change (see the file header).
 */
export function pageListOverlayScope(input: PageListOverlayInput): ListOverlayScope | null {
  const { data, pageId } = input;
  const modules = [...input.modules];
  const usesLists =
    modules.some(readsLists) || [...input.markup].some((html) => LIST_SCOPE_READ_RE.test(html));
  if (!usesLists) return null;

  const pageIds = new Set<string>([pageId]);
  const variant = data.pageVariants?.get(pageId)?.variant;
  if (variant !== undefined && modules.some((m) => generatesPages(m.fields, data))) {
    for (const p of data.pages.values()) {
      if (data.pageVariants?.get(p.id)?.variant !== variant) continue;
      if ((data.pageTypes.get(p.pageTypeSlug)?.def.properties.length ?? 0) === 0) continue;
      pageIds.add(p.id);
    }
  }
  return {
    listIds: [...data.lists.keys()].sort(),
    contentInstanceIds: [...new Set(input.contentInstanceIds)].sort(),
    pageIds: [...pageIds].sort(),
  };
}
