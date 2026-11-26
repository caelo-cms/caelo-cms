// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1754 — the write side of `page` properties (`docs/lists.md` §2):
 * a page that names other pages in a fixed order (an article's authors,
 * its reviewer).
 *
 * Reads hand the AI and the editor paths (`withHumanisedLinks` turns every
 * `caelo:page/<id>` into the page's path), so a write takes a path, a
 * reference or a bare page id and stores the reference — the same
 * round trip as an internal link (#724), so a reference follows the page
 * through renames and moves. Every named page must exist in the caller's
 * view, have the page type the property asks for, and not be the page
 * itself; each problem comes back as one sentence the AI can act on.
 *
 * The lookup reads exactly the named pages (by id and by path, in the
 * caller's branch view, through `pages.list`), never the site.
 */

import { formatPageRef, type PageTypeDef, parsePageRef } from "@caelo-cms/shared";
import { normalisedPath } from "../ops/content/path-candidates.js";

/** A page a `page` property may name, as the caller sees it. */
export interface PageRefTarget {
  readonly id: string;
  readonly path: string;
  /** Page type slug. */
  readonly pageType: string;
}

/** Reads the named pages in the caller's view (`pages.list` by ids and paths). */
export type PageRefLookup = (q: {
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}) => Promise<readonly PageRefTarget[]>;

/** The pages a write's `page` properties name, looked up once. */
export interface PageRefIndex {
  readonly byId: ReadonlyMap<string, PageRefTarget>;
  /** Normalised path (no trailing slash) → page id. */
  readonly byPath: ReadonlyMap<string, string>;
}

/** The index of a write that names no page. */
export const NO_PAGE_REFS: PageRefIndex = { byId: new Map(), byPath: new Map() };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What one written item of a `page` property names: a page id or a path. */
function namedBy(v: string): { id: string } | { path: string } | null {
  const ref = parsePageRef(v);
  if (ref !== null) return { id: ref };
  if (UUID_RE.test(v)) return { id: v.toLowerCase() };
  if (v.startsWith("/")) return { path: normalisedPath(v) };
  return null;
}

/**
 * Load the pages that the `page` properties of `def` name in
 * `propertySets` (each a page's properties as written).
 */
export async function loadPageRefIndex(
  lookup: PageRefLookup,
  def: PageTypeDef,
  propertySets: readonly Readonly<Record<string, unknown>>[],
): Promise<PageRefIndex> {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const fields = def.properties.filter((f) => f.type === "page");
  if (fields.length === 0) return NO_PAGE_REFS;
  for (const props of propertySets) {
    for (const f of fields) {
      const v = props[f.name];
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        const named = typeof item === "string" ? namedBy(item) : null;
        if (named === null) continue;
        if ("id" in named) ids.add(named.id);
        else paths.add(named.path);
      }
    }
  }
  if (ids.size + paths.size === 0) return NO_PAGE_REFS;
  const found = await lookup({ ids: [...ids], paths: [...paths] });
  const byId = new Map(found.map((p) => [p.id, p]));
  const byPath = new Map(found.map((p) => [normalisedPath(p.path), p.id]));
  return { byId, byPath };
}

/**
 * A `page` property's written value with every path and bare id turned
 * into `caelo:page/<id>`. An item that names no known page stays as
 * written, so {@link pageRefIssues} can name it.
 */
export function canonicalPageRefs(value: unknown, index: PageRefIndex): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item !== "string") return item;
    const named = namedBy(item);
    if (named === null) return item;
    const pageId = "id" in named ? named.id : index.byPath.get(named.path);
    return pageId !== undefined && index.byId.has(pageId) ? formatPageRef(pageId) : item;
  });
}

/**
 * Why the canonical value of a `page` property cannot be stored: a page
 * that does not exist, one of another page type than the property takes,
 * or the page itself. Empty when it can.
 *
 * @param selfId the page being written (null for a page being created).
 */
export function pageRefIssues(
  field: { readonly name: string; readonly pageType?: string },
  value: unknown,
  index: PageRefIndex,
  selfId: string | null,
): string[] {
  if (!Array.isArray(value)) return [];
  const issues: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const at = `properties.${field.name}`;
    const pageId = parsePageRef(item);
    const target = pageId === null ? undefined : index.byId.get(pageId);
    if (target === undefined) {
      issues.push(
        `${at}: "${item}" names no page of this site — pass the path of an existing page (list_pages), e.g. "/team/anna".`,
      );
      continue;
    }
    if (target.id === selfId) {
      issues.push(`${at}: a page cannot name itself (${target.path}).`);
      continue;
    }
    if (field.pageType !== undefined && target.pageType !== field.pageType) {
      issues.push(
        `${at}: ${target.path} is a "${target.pageType}" page; this property takes pages of page type "${field.pageType}" — name one of those, or give that page the type first (update_pages_many pageType).`,
      );
    }
  }
  return issues;
}
