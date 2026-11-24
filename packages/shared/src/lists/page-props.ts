// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1561 — what a page property reads as on a page whose own page
 * type does not declare it (`{{page.props.<name>}}`, and `{{props.<name>}}`
 * on a page-shaped list entry; `docs/lists.md` §8).
 *
 * Two different situations (maintainer decision 2026-11-24):
 *
 * - Another page type of the site declares the property. A module shared
 *   by News and Product pages shows a block only where the page's type has
 *   it, so on every other page the property is absent, exactly like a
 *   declared property without a value: a section over it renders nothing,
 *   an inverted section renders its body, `{{page.props.x}}` is empty. No
 *   finding.
 * - No page type of the site declares it: a typo, or a property that was
 *   removed. That is a broken placeholder, never copy, so it never turns
 *   falsy: it fails with {@link pagePropUnknownMarker}. The spot stays raw
 *   in the editor preview and in a staging build, the Stage's audit names
 *   it (`render/page-prop-unknown`), and Publish live refuses the build
 *   until it is repaired (#1604).
 *
 * The index is built once per render context from the loaded page types
 * (`ListRenderData.pageTypes` holds every page type of the site, in the
 * preview and in a build alike), so a lookup reads no page and costs
 * nothing per key.
 */

import type { FieldDef } from "./fields.js";
import type { LoadedPageType } from "./render-data.js";

/** Marker kind of a page property no page type of the site declares. */
export const PAGE_PROP_UNKNOWN = "page-prop-unknown";

/** The failure marker of `{{page.props.<name>}}` when no page type declares `<name>`. */
export function pagePropUnknownMarker(name: string): string {
  return `${PAGE_PROP_UNKNOWN}:${name}`;
}

/** Every page property the site's page types declare, by name. */
export interface PagePropertyIndex {
  /**
   * The declaration of `name` in some page type of the site, or undefined
   * when none declares it. When several page types declare the name, the
   * first by slug decides the shape of the absent value (a `link` keeps
   * `{{page.props.x.href}}` answerable), so preview and build agree
   * whatever order the page types were loaded in.
   */
  declaration(name: string): FieldDef | undefined;
}

/** Build the {@link PagePropertyIndex} of a render's page types. */
export function pagePropertyIndex(
  pageTypes: ReadonlyMap<string, LoadedPageType>,
): PagePropertyIndex {
  const byName = new Map<string, FieldDef>();
  const bySlug = [...pageTypes.values()].sort((a, b) =>
    a.def.slug < b.def.slug ? -1 : a.def.slug > b.def.slug ? 1 : 0,
  );
  for (const t of bySlug) {
    for (const p of t.def.properties) if (!byName.has(p.name)) byName.set(p.name, p);
  }
  return { declaration: (name) => byName.get(name) };
}
