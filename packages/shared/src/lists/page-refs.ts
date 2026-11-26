// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1754 — page references in page properties (`docs/lists.md` §2).
 *
 * A `page` property stores the pages a page names, in order, as
 * `caelo:page/<id>` strings: an article's authors, its reviewer, a talk's
 * speakers. Only a `page` field stores an array of such strings (a `term`
 * field stores `caelo:term/…`, a `link` field an object), so the stored
 * shape alone says which properties reference pages. The resolver's
 * reverse index, the render dependencies and the overlay scope read them
 * through {@link pageRefsOfProperties}, without the page type at hand.
 */

import { PAGE_REF_RE } from "./fields.js";

/** The page id of `caelo:page/<id>`; null when the string is no bare page reference. */
export function parsePageRef(ref: string): string | null {
  return PAGE_REF_RE.exec(ref)?.[1] ?? null;
}

/** `caelo:page/<id>`. */
export function formatPageRef(pageId: string): string {
  return `caelo:page/${pageId}`;
}

/**
 * The referenced page ids of every `page` property in `properties`, by
 * property name, in stored order. Properties of any other type are left
 * out.
 */
export function pageRefsOfProperties(
  properties: Readonly<Record<string, unknown>> | null | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of Object.entries(properties ?? {})) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const ids: string[] = [];
    for (const v of value) {
      const id = typeof v === "string" ? parsePageRef(v) : null;
      if (id === null) break;
      ids.push(id);
    }
    if (ids.length === value.length) out.set(name, ids);
  }
  return out;
}
