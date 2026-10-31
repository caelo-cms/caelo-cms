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
 * re-reads the view only when one did. An unchanged draft costs one
 * statement for the whole site, a change on another chat's isolated branch
 * costs nothing, and no edit can leave a preview stale.
 *
 * Only core rows are cached. Plugin answers about the site (the
 * `link-resolve` partition, list overlays, URL annotations of a pending
 * move) are asked per render: plugin data changes without moving the
 * counter.
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
import { sql } from "drizzle-orm";
import { loadPageRows, type PageInView, type PageRows, pagesInViewOf } from "./lists/pages-view.js";
import { type ListEntityView, loadListEntities } from "./lists/store.js";
import { driftIdsBetween, type PageTree, pageTreeOf } from "./ops/content/page-tree.js";

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
  const pageRows = await loadPageRows(tx, branchId);
  const live = pageRows.rows.filter((r) => r.deleted_at === null);
  const tree = pageTreeOf(live, pageRows.pending);
  const driftedIds =
    branchId && pageRows.pending.size > 0 ? driftIdsBetween(tree, pageTreeOf(live, new Map())) : [];

  const listTypes = await loadListEntities(tx, "listType", branchId);
  const lists = await loadListEntities(tx, "list", branchId);
  const pageTypes = await loadListEntities(tx, "pageType", branchId);

  const seoRows = (await tx.execute(sql`
    SELECT page_id::text AS page_id, meta_description, og_image_asset_id::text AS og_image,
           canonical_url
    FROM pages_seo
  `)) as unknown as {
    page_id: string;
    meta_description: string;
    og_image: string | null;
    canonical_url: string | null;
  }[];
  const mediaRows = (await tx.execute(sql`
    SELECT id::text AS id, slug, alt, width, height FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as {
    id: string;
    slug: string;
    alt: string;
    width: number | null;
    height: number | null;
  }[];
  const settingsRows = (await tx.execute(sql`
    SELECT site_base_url, sitemap_enabled, organization_json::text AS organization_json,
           site_language, home_page_id::text AS home_page_id
    FROM site_defaults WHERE id = 1
  `)) as unknown as {
    site_base_url: string | null;
    sitemap_enabled: boolean;
    organization_json: string | null;
    site_language: string | null;
    home_page_id: string | null;
  }[];
  const s = settingsRows[0];
  if (!s) {
    throw new Error(
      "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it",
    );
  }

  return {
    branchId,
    mark,
    pageRows,
    pages: pagesInViewOf(pageRows),
    tree,
    driftedIds,
    listTypes,
    lists,
    pageTypes,
    listBase: {
      seo: seoRows.map((r) => ({
        page_id: r.page_id,
        meta_description: r.meta_description,
        og_image: r.og_image,
      })),
      media: mediaRows.map((m) => ({ id: m.id, alt: m.alt, width: m.width, height: m.height })),
      siteLanguage: s.site_language,
      homePageId: s.home_page_id,
    },
    canonicalOverrides: new Map(seoRows.map((r) => [r.page_id, r.canonical_url || null])),
    media: mediaRows.map((m) => ({ id: m.id, slug: m.slug })),
    settings: {
      siteBaseUrl: s.site_base_url,
      sitemapEnabled: s.sitemap_enabled,
      organizationJson: s.organization_json,
      siteLanguage: s.site_language,
      homePageId: s.home_page_id,
    },
  };
}

/**
 * Views per branch (`""` = main), most recently used last. Bounded: each
 * view holds the whole site, and a preview only ever needs the newest
 * view of the branches being edited right now.
 */
const cache = new Map<string, SiteView>();
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
  const { fresh, mark } = await checkJournalMark(tx, hit?.mark ?? null, filter);
  if (hit && fresh) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const view = await readSiteView(tx, branchId, mark);
  // A read that saw its own transaction's uncommitted writes is not
  // cached: a rollback would undo them without a journal row.
  if (!mark.dirty) {
    cache.delete(key);
    cache.set(key, view);
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
