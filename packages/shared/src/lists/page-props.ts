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
 *   finding. The option flags of a `select` property (`layout_wide` for
 *   `layout`, `docs/lists.md` §2) are absent the same way: false.
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
import { emptyValueOf, FALSE } from "./resolve-values.js";
import type { ScopeValue } from "./scope.js";

/** Marker kind of a page property no page type of the site declares. */
export const PAGE_PROP_UNKNOWN = "page-prop-unknown";

/** The failure marker of `{{page.props.<name>}}` when no page type declares `<name>`. */
export function pagePropUnknownMarker(name: string): string {
  return `${PAGE_PROP_UNKNOWN}:${name}`;
}

/** Every page property the site's page types declare, by name. */
export interface PagePropertyIndex {
  /**
   * What `props.<key>` reads as on a page whose own type does not declare
   * `key`, when some page type of the site does: that declaration's empty
   * value (a `link` keeps `{{page.props.x.href}}` answerable), false for a
   * `select` property's option flag. Undefined when no page type declares
   * `key`.
   */
  absent(key: string): ScopeValue | undefined;
  /**
   * #1717 — the types the site's page types declare `key` with, sorted
   * (`["link", "text"]` when two disagree); empty when none declares it.
   * Names the property's type when a path into it cannot be answered.
   */
  types(key: string): readonly string[];
}

/** Build the {@link PagePropertyIndex} of a render's page types. */
export function pagePropertyIndex(
  pageTypes: ReadonlyMap<string, LoadedPageType>,
): PagePropertyIndex {
  const byName = new Map<string, FieldDef[]>();
  const flags = new Set<string>();
  for (const t of pageTypes.values()) {
    for (const p of t.def.properties) {
      byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
      if (p.type === "select") for (const o of p.options) flags.add(`${p.name}_${o}`);
    }
  }
  const absent = new Map<string, ScopeValue>();
  for (const [name, defs] of byName) absent.set(name, absentValueOf(defs));
  return {
    absent: (key) => absent.get(key) ?? (flags.has(key) ? FALSE : undefined),
    types: (key) => [...new Set((byName.get(key) ?? []).map((d) => d.type))].sort(),
  };
}

/**
 * The empty value of a property name some page types declare. When they
 * declare it with different types (`cta` a link on one, text on another),
 * no one declaration's empty value answers every path a shared module may
 * use, so the absent value is an empty record that answers the paths of
 * each: `{{page.props.cta}}` and `{{page.props.cta.href}}` are both empty,
 * never a raw tag, whatever order the page types were loaded in.
 */
function absentValueOf(defs: readonly FieldDef[]): ScopeValue {
  const empties = defs.map(emptyValueOf);
  const first = empties[0] as ScopeValue;
  if (defs.every((d) => d.type === defs[0]?.type)) return first;
  return {
    kind: "record",
    text: "",
    present: false,
    get(key) {
      for (const v of empties) {
        const hit = v.kind === "record" ? v.get(key) : undefined;
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
  };
}
