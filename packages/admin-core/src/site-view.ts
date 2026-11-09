// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — the site as one chat branch sees it, read once and shared
 * by everything a preview render needs from the whole site: the list
 * render data (pages, list types, lists, page types, SEO summaries, media
 * metadata, site language), the link index (page paths and statuses,
 * media slugs), the breadcrumbs (short titles, canonical overrides) and
 * the page tree a pending move is composed against.
 *
 * Before, each of those consumers read the whole site itself — the pages
 * table five times per render, media twice — so one preview's cost grew
 * with the site. Now one read builds this view, and the admin keeps it
 * in memory per branch, with the change-journal mark it was read at
 * (issue #1267, docs/dev/state-and-changes.md). A render proves in one
 * statement that no journaled change to a table read here became visible
 * since — on main or on this branch, whoever made it (an op, a Stage, an
 * undo, a migration, a psql session, another admin instance) — and
 * re-reads only what one changed (#1270, `site-view-read.ts`). An unchanged draft costs one
 * statement for the whole site, a change on another chat's isolated branch
 * costs nothing, and no edit can leave a preview stale.
 *
 * Only core rows are cached. Plugin answers about the site (the
 * `link-resolve` partition, list overlays, URL annotations of a pending
 * move or plugin row) are asked per render: plugin data changes without
 * moving the counter.
 *
 * The rows are the same for every actor: the tables read here have one
 * policy for every authenticated session.
 */

import {
  checkJournalMark,
  type JournalFilter,
  type JournalMark,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import type { LinkIndexMedia } from "@caelo-cms/shared";
import type { ListRenderBase } from "@caelo-cms/static-generator";
import type { PageInView, PageRows } from "./lists/pages-view.js";
import type { ListEntityView } from "./lists/store.js";
import type { PageTree } from "./ops/content/page-tree.js";
import { readSiteDelta, readSiteParts, type SiteViewParts, siteViewOf } from "./site-view-read.js";

/** The `site_defaults` columns a render reads. */
export interface SiteViewSettings {
  readonly siteBaseUrl: string | null;
  readonly sitemapEnabled: boolean;
  readonly organizationJson: string | null;
  readonly siteLanguage: string | null;
  readonly homePageId: string | null;
}

/** One branch's view of the whole site (see the file header). */
export interface SiteView {
  readonly branchId: string | null;
  /** Where in the change journal this view was read (#1267). */
  readonly mark: JournalMark;
  readonly pageRows: PageRows;
  /** {@link pagesInViewOf} of `pageRows`. */
  readonly pages: readonly PageInView[];
  /** The page tree with the branch's pending edits. */
  readonly tree: PageTree;
  /** The pages whose path a pending rename or move changes (compose them). */
  readonly driftedIds: readonly string[];
  readonly listTypes: readonly ListEntityView<"listType">[];
  readonly lists: readonly ListEntityView<"list">[];
  readonly pageTypes: readonly ListEntityView<"pageType">[];
  /** SEO summaries, media metadata, site language: the list render base. */
  readonly listBase: ListRenderBase;
  /** `pages_seo.canonical_url` per page, empty ones as null. */
  readonly canonicalOverrides: ReadonlyMap<string, string | null>;
  /** Every live media asset by id and slug (the link index's media). */
  readonly media: readonly LinkIndexMedia[];
  readonly settings: SiteViewSettings;
}

/**
 * The journal rows that change a branch's site view: the kinds of every
 * table {@link readSiteView} reads, on main or on that branch. An update or
 * delete counts on any branch, because a journal row names the branch AFTER
 * the change: a lock takeover re-points a pending snapshot away from a
 * branch the row no longer names, and Stage / undo mark headers. A header
 * insert carries no state of its own (its entity snapshots do).
 */
export function siteViewJournalFilter(branchId: string | null): JournalFilter {
  return {
    kinds: [
      "page",
      "page_terms",
      "page_seo",
      "media",
      "site_defaults",
      "list_type",
      "list",
      "page_type",
      "plugin",
      "plugin_installation",
      "plugin_grant",
      "snapshot",
    ],
    branchId,
    unscopedOps: ["update", "delete", "truncate"],
    kindOps: { snapshot: ["update", "delete", "truncate"] },
  };
}

/** Read the whole view (no cache): about ten statements. */
export async function readSiteView(
  tx: TransactionRunner,
  branchId: string | null,
  mark: JournalMark,
): Promise<SiteView> {
  return siteViewOf(branchId, mark, await readSiteParts(tx, branchId));
}

/**
 * Views per branch (`""` = main), most recently used last. Bounded: each
 * view holds the whole site, and a preview only ever needs the newest
 * view of the branches being edited right now.
 */
const cache = new Map<string, { readonly view: SiteView; readonly parts: SiteViewParts }>();
const MAX_CACHED_VIEWS = 8;

/**
 * The branch's site view as `tx` sees it: from the cache when no journaled
 * change reached it since it was read, else read now and cached.
 */
export async function loadSiteView(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<SiteView> {
  const key = branchId ?? "";
  const filter = siteViewJournalFilter(branchId);
  const hit = cache.get(key);
  // One statement, hit or miss: the check, and the mark of the read below
  // (taken before its statements, so a change committing during the read
  // is unseen by the mark and invalidates once).
  const { fresh, mark } = await checkJournalMark(tx, hit?.view.mark ?? null, filter);
  if (hit && fresh) {
    // Still exact now, so it is the view a read at this mark would give:
    // keep the new mark (#1269). The next check then costs what was written
    // since this one, not everything since the view was read — the journal
    // rows the filter reads and then drops (another kind's flood, every
    // snapshot header a write inserts, other branches' writes) would
    // otherwise pile up behind an old mark on every render. A mark that saw
    // this transaction's own uncommitted writes is never stored.
    const current = mark.dirty ? hit : { ...hit, view: { ...hit.view, mark } };
    cache.delete(key);
    cache.set(key, current);
    return current.view;
  }
  // #1270 — carry the cached read forward by what changed since its mark;
  // a whole read only when that cannot be exact or would not be cheaper.
  const parts =
    (hit
      ? await readSiteDelta(tx, {
          branchId,
          parts: hit.parts,
          from: hit.view.mark,
          to: mark,
          filter,
        })
      : null) ?? (await readSiteParts(tx, branchId));
  const view = siteViewOf(branchId, mark, parts);
  // A read that saw its own transaction's uncommitted writes is not
  // cached: a rollback would undo them without a journal row.
  if (!mark.dirty) {
    cache.delete(key);
    cache.set(key, { view, parts });
    while (cache.size > MAX_CACHED_VIEWS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return view;
}

/** Test seam: forget every cached view (the rows-read test measures cold reads). */
export function clearSiteViewCache(): void {
  cache.clear();
}
