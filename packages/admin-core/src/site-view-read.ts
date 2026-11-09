// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1270 — reading a branch's site view (`site-view.ts`): whole, or
 * carried forward from a cached read by the journal rows written since.
 *
 * A view is built from its parts — the rows read from the database — and
 * everything else in it (the pages with their pending states applied, the
 * page tree, the drifted pages, the list render base) is derived from the
 * parts in memory. A whole read reads every part. A delta reads the
 * journal rows the cached read's mark has not seen (`readChanges` from
 * the old mark to the new one) and re-reads only the rows they name: the
 * pages by id with their pending states, the SEO rows and media assets by
 * id, a list kind whose rows changed. Then it derives the view again. A
 * delta and a whole read at the same mark give the same view (the
 * maintained == rebuilt test, docs/dev/state-and-changes.md).
 *
 * Before, any matching change re-read the whole site: under 20 agents and
 * five editors that was the scale gate's top cost (#1269, the branch's
 * pending overlay 28 × 21 s, the pages 20 × 15 s on 50k pages). A delta
 * reads what changed.
 *
 * A delta falls back to a whole read when it cannot be exact or would
 * not be cheaper: the reader's snapshot does not follow the mark (an old
 * transaction must not be served newer rows), the journal lost rows the
 * comparison needs, a truncate, a table this file does not know, or more
 * than {@link MAX_DELTA_CHANGES} journal rows or pages (a Stage of the
 * whole draft).
 *
 * Row order is part of the view, so both paths sort the same way: pages
 * by current path, then id; SEO rows, media and pending states by id —
 * in JavaScript, by code unit, never by the database collation a delta
 * could not reproduce. No consumer depends on the collation: list
 * queries sort themselves (`pageOrder`, ties by id), and lookups by path
 * or id match one page.
 */

import {
  type JournalFilter,
  type JournalMark,
  readChanges,
  snapshotFollows,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { loadPageRows, type PageRow, type PageRows, pagesInViewOf } from "./lists/pages-view.js";
import { type ListEntityView, loadListEntities } from "./lists/store.js";
import { loadSiteDesignations } from "./ops/content/compose-paths.js";
import { driftIdsBetween, pageTreeOf } from "./ops/content/page-tree.js";
import type { SiteView } from "./site-view.js";
import type { PageState } from "./snapshots/state.js";

/** A `pages_seo` row as the view reads it. */
export interface SeoRow {
  readonly page_id: string;
  readonly meta_description: string;
  readonly og_image: string | null;
  readonly canonical_url: string | null;
}

/** A live `media_assets` row as the view reads it. */
export interface MediaRow {
  readonly id: string;
  readonly slug: string;
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** The `site_defaults` row as the view reads it. */
interface SettingsRow {
  readonly site_base_url: string | null;
  readonly sitemap_enabled: boolean;
  readonly organization_json: string | null;
  readonly site_language: string | null;
}

/** The rows a view is derived from (see the file header). */
export interface SiteViewParts {
  readonly pageRows: PageRows;
  readonly listTypes: readonly ListEntityView<"listType">[];
  readonly lists: readonly ListEntityView<"list">[];
  readonly pageTypes: readonly ListEntityView<"pageType">[];
  /** By page id. */
  readonly seo: readonly SeoRow[];
  /** By id. */
  readonly media: readonly MediaRow[];
  readonly settings: SettingsRow;
  readonly homePageId: string | null;
}

/**
 * Above this many journal rows, or pages to re-read, a delta reads the
 * whole site instead: one re-read by id per page stops being cheaper than
 * the sequential read of all of them well before the site's size, and a
 * Stage of a whole draft is a rare, already expensive moment.
 */
export const MAX_DELTA_CHANGES = 2000;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byPathThenId = (a: PageRow, b: PageRow): number =>
  byCodeUnit(a.current_path, b.current_path) || byCodeUnit(a.id, b.id);

function sortedPending(pending: ReadonlyMap<string, PageState>): Map<string, PageState> {
  return new Map([...pending].sort(([a], [b]) => byCodeUnit(a, b)));
}

async function readSeo(tx: TransactionRunner, pageIds?: readonly string[]): Promise<SeoRow[]> {
  const rows = (await tx.execute(sql`
    SELECT page_id::text AS page_id, meta_description, og_image_asset_id::text AS og_image,
           canonical_url
    FROM pages_seo
    ${pageIds ? sql`WHERE page_id = ANY(${uuidArray(pageIds)})` : sql``}
  `)) as unknown as SeoRow[];
  return rows.sort((a, b) => byCodeUnit(a.page_id, b.page_id));
}

async function readMedia(tx: TransactionRunner, ids?: readonly string[]): Promise<MediaRow[]> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, alt, width, height FROM media_assets
    WHERE deleted_at IS NULL ${ids ? sql`AND id = ANY(${uuidArray(ids)})` : sql``}
  `)) as unknown as MediaRow[];
  return rows.sort((a, b) => byCodeUnit(a.id, b.id));
}

async function readSettings(tx: TransactionRunner): Promise<SettingsRow> {
  const rows = (await tx.execute(sql`
    SELECT site_base_url, sitemap_enabled, organization_json::text AS organization_json,
           site_language
    FROM site_defaults WHERE id = 1
  `)) as unknown as SettingsRow[];
  const s = rows[0];
  if (!s) {
    throw new Error(
      "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it",
    );
  }
  return s;
}

/** Read every part (no cache): about ten statements. */
export async function readSiteParts(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<SiteViewParts> {
  const pageRows = await loadPageRows(tx, branchId);
  return {
    pageRows: {
      rows: [...pageRows.rows].sort(byPathThenId),
      pending: sortedPending(pageRows.pending),
    },
    listTypes: await loadListEntities(tx, "listType", branchId),
    lists: await loadListEntities(tx, "list", branchId),
    pageTypes: await loadListEntities(tx, "pageType", branchId),
    seo: await readSeo(tx),
    media: await readMedia(tx),
    settings: await readSettings(tx),
    homePageId: (await loadSiteDesignations(tx, branchId)).homePageId,
  };
}

/** What the journal rows since a mark ask a delta to re-read. */
interface DeltaTargets {
  readonly pageIds: Set<string>;
  readonly seoPageIds: Set<string>;
  readonly mediaIds: Set<string>;
  readonly listKinds: Set<"listType" | "list" | "pageType">;
  readonly headerIds: Set<string>;
}

/** Per journaled table: what a change of one of its rows re-reads. */
const DELTA_OF_TABLE: Readonly<Record<string, (t: DeltaTargets, rowId: string) => void>> = {
  pages: (t, id) => t.pageIds.add(id),
  page_snapshots: (t, id) => t.pageIds.add(id),
  page_terms: (t, id) => t.pageIds.add(id),
  pages_seo: (t, id) => t.seoPageIds.add(id),
  media_assets: (t, id) => t.mediaIds.add(id),
  list_types: (t) => t.listKinds.add("listType"),
  list_type_snapshots: (t) => t.listKinds.add("listType"),
  lists: (t) => t.listKinds.add("list"),
  list_snapshots: (t) => t.listKinds.add("list"),
  page_types: (t) => t.listKinds.add("pageType"),
  page_type_snapshots: (t) => t.listKinds.add("pageType"),
  // A list type of a plugin is shown only while the plugin is available,
  // with the plugin's slug.
  plugins: (t) => t.listKinds.add("listType"),
  plugin_installation_versions: (t) => t.listKinds.add("listType"),
  plugin_capability_grants: (t) => t.listKinds.add("listType"),
  // Settings and the home page designation are re-read by every delta.
  site_defaults: () => {},
  // Stage, undo and lock takeover update a header: the pending states of
  // the entities in that snapshot change (see `headerEntities`).
  site_snapshots: (t, id) => t.headerIds.add(id),
};

/**
 * The entities whose snapshot rows a changed header holds — at most
 * `limit` rows, so a whole-draft Stage is noticed without reading it all.
 */
async function headerEntities(
  tx: TransactionRunner,
  headerIds: readonly string[],
  limit: number,
): Promise<{ kind: "page" | "listType" | "list" | "pageType"; id: string }[]> {
  const ids = uuidArray(headerIds);
  return (await tx.execute(sql`
    SELECT 'page' AS kind, page_id::text AS id FROM page_snapshots WHERE site_snapshot_id = ANY(${ids})
    UNION ALL
    SELECT 'list', list_id::text FROM list_snapshots WHERE site_snapshot_id = ANY(${ids})
    UNION ALL
    SELECT 'listType', list_type_id::text FROM list_type_snapshots WHERE site_snapshot_id = ANY(${ids})
    UNION ALL
    SELECT 'pageType', page_type_id::text FROM page_type_snapshots WHERE site_snapshot_id = ANY(${ids})
    LIMIT ${limit}
  `)) as unknown as { kind: "page" | "listType" | "list" | "pageType"; id: string }[];
}

/**
 * `parts` (read at `from`) carried forward to `to` by the journal rows
 * between them, or null when only a whole read is exact or cheaper (see
 * the file header). `to` is the mark `tx` took for this read, before any
 * of its statements: a change committing during the delta is unseen by
 * `to` and comes again with the next one.
 */
export async function readSiteDelta(
  tx: TransactionRunner,
  input: {
    readonly branchId: string | null;
    readonly parts: SiteViewParts;
    readonly from: JournalMark;
    readonly to: JournalMark;
    readonly filter: JournalFilter;
  },
): Promise<SiteViewParts | null> {
  const { branchId, parts, from, to, filter } = input;
  if (!snapshotFollows(from.snapshot, to.snapshot)) return null;
  const read = await readChanges(tx, {
    cursor: from.snapshot,
    target: to.snapshot,
    after: null,
    filter,
    limit: MAX_DELTA_CHANGES,
    ownXid: from.ownXid,
  });
  if (read.needsRebuild || read.more) return null;

  const targets: DeltaTargets = {
    pageIds: new Set(),
    seoPageIds: new Set(),
    mediaIds: new Set(),
    listKinds: new Set(),
    headerIds: new Set(),
  };
  for (const c of read.changes) {
    const apply = DELTA_OF_TABLE[c.table];
    if (c.op === "truncate" || apply === undefined) return null;
    apply(targets, c.rowId);
  }
  if (targets.headerIds.size > 0) {
    const held = await headerEntities(tx, [...targets.headerIds], MAX_DELTA_CHANGES + 1);
    if (held.length > MAX_DELTA_CHANGES) return null;
    for (const e of held) {
      if (e.kind === "page") targets.pageIds.add(e.id);
      else targets.listKinds.add(e.kind);
    }
  }
  if (targets.pageIds.size > MAX_DELTA_CHANGES) return null;

  const pageRows =
    targets.pageIds.size === 0
      ? parts.pageRows
      : patchPageRows(
          parts.pageRows,
          targets.pageIds,
          await loadPageRows(tx, branchId, { ids: [...targets.pageIds] }),
        );
  return {
    pageRows,
    listTypes: targets.listKinds.has("listType")
      ? await loadListEntities(tx, "listType", branchId)
      : parts.listTypes,
    lists: targets.listKinds.has("list")
      ? await loadListEntities(tx, "list", branchId)
      : parts.lists,
    pageTypes: targets.listKinds.has("pageType")
      ? await loadListEntities(tx, "pageType", branchId)
      : parts.pageTypes,
    seo:
      targets.seoPageIds.size === 0
        ? parts.seo
        : patchById(
            parts.seo,
            (r) => r.page_id,
            targets.seoPageIds,
            await readSeo(tx, [...targets.seoPageIds]),
          ),
    media:
      targets.mediaIds.size === 0
        ? parts.media
        : patchById(
            parts.media,
            (r) => r.id,
            targets.mediaIds,
            await readMedia(tx, [...targets.mediaIds]),
          ),
    // One row each: cheaper to re-read than to reason about (the home page
    // designation also depends on the designated page's branch).
    settings: await readSettings(tx),
    homePageId: (await loadSiteDesignations(tx, branchId)).homePageId,
  };
}

/**
 * `old` with the pages `ids` replaced by `fresh` (a page `fresh` lacks is
 * gone from the view). The order is kept without sorting when no re-read
 * page is new or moved, which is the usual edit.
 */
function patchPageRows(old: PageRows, ids: ReadonlySet<string>, fresh: PageRows): PageRows {
  const freshById = new Map(fresh.rows.map((r) => [r.id, r]));
  const oldPathOf = new Map<string, string>();
  for (const r of old.rows) if (ids.has(r.id)) oldPathOf.set(r.id, r.current_path);
  const inPlace = fresh.rows.every((r) => oldPathOf.get(r.id) === r.current_path);
  let rows: PageRow[];
  if (inPlace) {
    rows = [];
    for (const r of old.rows) {
      if (!ids.has(r.id)) rows.push(r);
      else {
        const f = freshById.get(r.id);
        if (f) rows.push(f);
      }
    }
  } else {
    rows = [...old.rows.filter((r) => !ids.has(r.id)), ...fresh.rows].sort(byPathThenId);
  }
  const pending = new Map(old.pending);
  for (const id of ids) pending.delete(id);
  for (const [id, s] of fresh.pending) pending.set(id, s);
  return { rows, pending: sortedPending(pending) };
}

/** `old` (sorted by key) with the rows of `ids` replaced by `fresh`, still sorted. */
function patchById<T>(
  old: readonly T[],
  keyOf: (row: T) => string,
  ids: ReadonlySet<string>,
  fresh: readonly T[],
): T[] {
  return [...old.filter((r) => !ids.has(keyOf(r))), ...fresh].sort((a, b) =>
    byCodeUnit(keyOf(a), keyOf(b)),
  );
}

/** The view `parts` give at `mark`: everything derived from the rows. */
export function siteViewOf(
  branchId: string | null,
  mark: JournalMark,
  parts: SiteViewParts,
): SiteView {
  const { pageRows, seo, media, settings: s, homePageId } = parts;
  const live = pageRows.rows.filter((r) => r.deleted_at === null);
  const tree = pageTreeOf(live, pageRows.pending);
  const driftedIds =
    branchId && pageRows.pending.size > 0 ? driftIdsBetween(tree, pageTreeOf(live, new Map())) : [];
  return {
    branchId,
    mark,
    pageRows,
    pages: pagesInViewOf(pageRows),
    tree,
    driftedIds,
    listTypes: parts.listTypes,
    lists: parts.lists,
    pageTypes: parts.pageTypes,
    listBase: {
      seo: seo.map((r) => ({
        page_id: r.page_id,
        meta_description: r.meta_description,
        og_image: r.og_image,
      })),
      media: media.map((m) => ({ id: m.id, alt: m.alt, width: m.width, height: m.height })),
      siteLanguage: s.site_language,
      homePageId,
    },
    canonicalOverrides: new Map(seo.map((r) => [r.page_id, r.canonical_url || null])),
    media: media.map((m) => ({ id: m.id, slug: m.slug })),
    settings: {
      siteBaseUrl: s.site_base_url,
      sitemapEnabled: s.sitemap_enabled,
      organizationJson: s.organization_json,
      siteLanguage: s.site_language,
      homePageId,
    },
  };
}
