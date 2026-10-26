// SPDX-License-Identifier: MPL-2.0

/**
 * Render dependencies of a build (epic #1107, `docs/lists.md` §10): which
 * lists, list types, page queries and page-tree sources every page read,
 * written by the static generator as `render-deps.json`, and the
 * selection an incremental build runs on it — every page whose deps
 * intersect the change.
 *
 * A query matches by its filter (page type, terms, parent), so a page
 * that ENTERED, LEFT or CHANGED inside a filter reaches every page that
 * rendered that query. That is why the file keeps each page's filter
 * attributes as of the build: "left the filter" can only be seen against
 * what the page was before.
 *
 * Cost: one pass over the recorded deps per change set — O(changes ×
 * deps), never a re-render of the site to find out.
 */

import type { ListPageRecord, ListRenderDeps } from "./render-data.js";

export const RENDER_DEPS_FILE = "render-deps.json";
export const RENDER_DEPS_VERSION = 2;

/** A page's filter-relevant attributes as of a build. */
export interface RenderDepsPageAttrs {
  readonly pageType: string;
  readonly terms: readonly string[];
  readonly parent: string | null;
  readonly title: string;
  readonly inBuild: boolean;
}

/** `render-deps.json`. */
export interface RenderDepsFile {
  readonly version: typeof RENDER_DEPS_VERSION;
  /** Per rendered page: what its render read. */
  readonly pages: Readonly<Record<string, ListRenderDeps>>;
  /** Per known page: its filter attributes when the build ran. */
  readonly index: Readonly<Record<string, RenderDepsPageAttrs>>;
}

/** The attributes {@link RenderDepsFile.index} keeps for a page. */
export function renderDepsAttrs(p: ListPageRecord): RenderDepsPageAttrs {
  return {
    pageType: p.pageTypeSlug,
    terms: [...p.terms].sort(),
    parent: p.parentId,
    title: p.title,
    inBuild: p.inBuild,
  };
}

/**
 * Merge the deps of a (possibly incremental) build into the previous
 * file: rebuilt pages replace their entry, the index is the current one.
 */
export function mergeRenderDeps(
  previous: RenderDepsFile | null,
  rebuilt: ReadonlyMap<string, ListRenderDeps>,
  pages: Iterable<ListPageRecord>,
): RenderDepsFile {
  const out: Record<string, ListRenderDeps> = { ...(previous?.pages ?? {}) };
  for (const [id, deps] of rebuilt) out[id] = deps;
  const index: Record<string, RenderDepsPageAttrs> = {};
  for (const p of pages) index[p.id] = renderDepsAttrs(p);
  for (const id of Object.keys(out)) if (!index[id]) delete out[id];
  return { version: RENDER_DEPS_VERSION, pages: out, index };
}

/** Parse a stored deps file; null when it is absent or of another version. */
export function parseRenderDeps(raw: string | null): RenderDepsFile | null {
  if (raw === null) return null;
  const v = JSON.parse(raw) as Partial<RenderDepsFile>;
  if (v.version !== RENDER_DEPS_VERSION || !v.pages || !v.index) return null;
  return v as RenderDepsFile;
}

/** What changed since the build the deps file describes. */
export interface RenderChange {
  readonly pageIds: readonly string[];
  readonly listIds: readonly string[];
  readonly listTypeSlugs: readonly string[];
}

/**
 * The pages an incremental build must rebuild beyond the changed pages
 * themselves:
 *
 * - every page that read a changed list or list type;
 * - for every changed page: every page whose query filter matches the
 *   page's attributes before OR after the change (entered, left or
 *   changed inside the filter);
 * - every page with page-tree deps (breadcrumbs, children, siblings,
 *   term pages) when a changed page's title, parent or build membership
 *   changed;
 * - every page whose system source rendered a changed page as an entry
 *   (its `props`, `terms`, `updated_at` show there).
 *
 * `current` is the page index as the new build sees it.
 */
export function selectDependentPages(
  deps: RenderDepsFile,
  change: RenderChange,
  current: ReadonlyMap<string, RenderDepsPageAttrs>,
): Set<string> {
  const out = new Set<string>();
  const lists = new Set(change.listIds);
  const types = new Set(change.listTypeSlugs);
  const changedPages = new Set(change.pageIds);
  const states: RenderDepsPageAttrs[] = [];
  let treeChanged = false;
  for (const id of change.pageIds) {
    const before = deps.index[id];
    const after = current.get(id);
    if (before) states.push(before);
    if (after) states.push(after);
    if (
      !before ||
      !after ||
      before.title !== after.title ||
      before.parent !== after.parent ||
      before.inBuild !== after.inBuild
    ) {
      treeChanged = true;
    }
  }
  const matches = (q: ListRenderDeps["queries"][number], p: RenderDepsPageAttrs): boolean =>
    (q.pageType === null || q.pageType === p.pageType) &&
    (q.parent === null || q.parent === p.parent) &&
    (q.terms.length === 0 || q.terms.some((t) => p.terms.includes(t)));
  for (const [pageId, d] of Object.entries(deps.pages)) {
    if (
      d.lists.some((l) => lists.has(l)) ||
      d.listTypes.some((t) => types.has(t)) ||
      (treeChanged && d.pageTree) ||
      d.pages.some((id) => changedPages.has(id)) ||
      (states.length > 0 && d.queries.some((q) => states.some((s) => matches(q, s))))
    ) {
      out.add(pageId);
    }
  }
  return out;
}
