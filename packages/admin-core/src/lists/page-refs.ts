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
 *
 * The other direction holds too: a page cannot leave the page type a
 * property naming it asks for ({@link incomingPageRefIssue}).
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { formatPageRef, type PageTypeDef, parsePageRef } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { headOverlaySql } from "../draft.js";
import { normalisedPath } from "../ops/content/path-candidates.js";
import { loadPageRows, pagesInViewOf } from "./pages-view.js";
import { loadListEntities } from "./store.js";

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
      // An omitted property takes its default (`fitPageToType`), which is checked too.
      const v = Object.hasOwn(props, f.name) ? props[f.name] : f.default;
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

/**
 * Why page `pageId` cannot change from page type `fromSlug` to `toSlug`:
 * pages name it in a `page` property that takes only pages of `fromSlug`
 * (an article's `authors` asking for `author`), so the change would leave
 * them naming a page their property refuses — and refuse their next edit.
 * Null when nothing names it so.
 *
 * Runs only on a type change, and reads only candidates: the live pages of
 * the types with such a property (by page type, indexed) whose properties
 * mention the page, and, on a branch, the branch's pending pages that do;
 * each is confirmed on its state in the caller's view.
 */
export async function incomingPageRefIssue(
  tx: TransactionRunner,
  branchId: string | null,
  page: { readonly id: string; readonly label: string },
  fromSlug: string,
  toSlug: string,
): Promise<string | null> {
  if (fromSlug === toSlug) return null;
  const types = await loadListEntities(tx, "pageType", branchId);
  const asking = new Map<string, string[]>();
  for (const t of types) {
    const props = t.state.definition.properties
      .filter((f) => f.type === "page" && f.pageType === fromSlug)
      .map((f) => f.name);
    if (props.length > 0) asking.set(t.id, props);
  }
  if (asking.size === 0) return null;
  const visible = branchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  const live = (await tx.execute(sql`
    SELECT p.id::text AS id FROM pages p
     WHERE p.page_type_id = ANY(${uuidArray([...asking.keys()])}) AND p.deleted_at IS NULL
       AND ${visible} AND strpos(p.properties::text, ${page.id}) > 0
  `)) as unknown as { id: string }[];
  const pending = branchId
    ? ((await tx.execute(
        headOverlaySql({
          kind: "page",
          table: "page_snapshots",
          branchId,
          columns: sql`NULL AS state`,
          where: sql`strpos((es.state->'properties')::text, ${page.id}) > 0`,
        }),
      )) as unknown as { entity_id: string }[])
    : [];
  const ids = [...new Set([...live.map((r) => r.id), ...pending.map((r) => r.entity_id)])];
  if (ids.length === 0) return null;
  const ref = formatPageRef(page.id);
  const naming: string[] = [];
  for (const p of pagesInViewOf(await loadPageRows(tx, branchId, { ids }))) {
    for (const prop of asking.get(p.pageTypeId) ?? []) {
      const v = p.properties[prop];
      if (Array.isArray(v) && v.includes(ref)) naming.push(`${prop} of ${p.currentPath}`);
    }
  }
  if (naming.length === 0) return null;
  return `${page.label} is named as a "${fromSlug}" page by ${naming.length} page propert${naming.length === 1 ? "y" : "ies"} (${naming.slice(0, 5).join(", ")}${naming.length > 5 ? ", …" : ""}) that take only that type — remove it there first (update_pages_many properties), or drop pageType from the property (upsert_page_types_many), then change the type to "${toSlug}".`;
}
