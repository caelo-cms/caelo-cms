// SPDX-License-Identifier: MPL-2.0

/**
 * #1156 — a page's SEO fields as draft state.
 *
 * SEO belongs to the page and travels with it: a chat's SEO write does not
 * touch the live `pages_seo` row. It emits a page snapshot on the chat's
 * branch whose `state.seo` carries the new fields (`PageState.seo`), the
 * same pending change a title edit is. A Stage merges it into `pages_seo`
 * (`chat/publish.ts`), "undo this chat" drops it, a revert restores it, and
 * nothing of it reaches a build before the merge.
 *
 * `state.seo` is present exactly when the branch wrote SEO: an SEO op sets
 * it and a later edit of the page on the branch carries it along; a page
 * snapshot that never touched SEO (a title edit) has none. So a Stage of a
 * title edit leaves `pages_seo` alone, and an SEO write made outside the
 * chat in the meantime survives it.
 *
 * The overlay rule every reader shares ({@link pageSeoViewSql}): the
 * page's LATEST pending page snapshot on the caller's branch decides. When
 * that snapshot carries `seo`, its fields win; when it carries none or the
 * branch has no pending snapshot of the page, the live row stands. Outside
 * a chat the view is the live row.
 *
 * A missing `pages_seo` row and a row holding the column defaults are the
 * same thing to every reader (the build reads both as "no description");
 * {@link PAGE_SEO_COLUMN_DEFAULTS} is that row, used where a write needs a
 * complete state to start from.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
import type { PageSeoState } from "../snapshots/state.js";

/**
 * The `pages_seo` column defaults (migration 0027), i.e. what a page
 * without a row reads as. Stored data's own shape, not a substitute value:
 * `INSERT INTO pages_seo (page_id)` produces exactly this.
 */
export const PAGE_SEO_COLUMN_DEFAULTS: PageSeoState = Object.freeze({
  metaDescription: "",
  ogImageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  changefreq: "weekly",
  priority: 0.5,
  autofilledAt: null,
  optimizedAt: null,
});

/** The fields a pending SEO change can differ in, as `PageSeoState` keys. */
export const PAGE_SEO_FIELDS = [
  "metaDescription",
  "ogImageAssetId",
  "canonicalUrl",
  "noindex",
  "changefreq",
  "priority",
] as const satisfies readonly (keyof PageSeoState)[];

/**
 * The key a page id has in every map these helpers return: Postgres prints
 * uuids lowercase, while a caller's (Zod-valid) uuid may be uppercase. Every
 * lookup by a caller's id goes through this, or it misses and the caller
 * silently builds on the column defaults.
 */
export const pageKey = (pageId: string): string => pageId.toLowerCase();

/** One SEO field name. */
export type PageSeoField = (typeof PAGE_SEO_FIELDS)[number];

/** A page's SEO in the caller's view. */
export interface PageSeoView {
  readonly state: PageSeoState;
  /** When the view's state was written (the live row's or the pending change's). */
  readonly updatedAt: string;
  /**
   * Fields the caller's branch changed against the live row, i.e. what a
   * Stage would merge. Empty outside a chat and for an untouched page.
   */
  readonly pendingFields: readonly PageSeoField[];
}

interface SeoViewRow {
  page_id: string;
  meta_description: string;
  og_image_asset_id: string | null;
  canonical_url: string | null;
  noindex: boolean;
  changefreq: string;
  priority: number | string;
  autofilled_at: Date | string | null;
  optimized_at: Date | string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOpt = (v: Date | string | null): string | null => (v === null ? null : iso(v));

function rowToState(r: SeoViewRow): PageSeoState {
  return {
    metaDescription: r.meta_description,
    ogImageAssetId: r.og_image_asset_id,
    canonicalUrl: r.canonical_url,
    noindex: r.noindex,
    changefreq: r.changefreq,
    priority: Number(r.priority),
    autofilledAt: isoOpt(r.autofilled_at),
    optimizedAt: isoOpt(r.optimized_at),
  };
}

const idFilter = (column: string, pageIds: readonly string[] | undefined): SQL =>
  pageIds === undefined
    ? sql``
    : sql` AND ${sql.raw(column)} IN (${sql.join(
        pageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

/**
 * A subquery with one row per page that has SEO in the caller's view —
 * the live `pages_seo` columns (`page_id`, `meta_description`,
 * `og_image_asset_id`, `canonical_url`, `noindex`, `changefreq`,
 * `priority`, `autofilled_at`, `optimized_at`, `updated_at`) with the
 * branch's pending SEO laid over them. Join it like the table it replaces;
 * a page without a row in it reads as {@link PAGE_SEO_COLUMN_DEFAULTS}.
 *
 * @param pageIds restrict both sides to these pages (an empty list matches
 *   nothing); omit for every page.
 */
export function pageSeoViewSql(
  chatBranchId: string | null | undefined,
  pageIds?: readonly string[],
): SQL {
  if (pageIds !== undefined && pageIds.length === 0) {
    return sql`(SELECT s.* FROM pages_seo s WHERE false)`;
  }
  const liveColumns = sql`s.page_id, s.meta_description, s.og_image_asset_id, s.canonical_url,
    s.noindex, s.changefreq, s.priority, s.autofilled_at, s.optimized_at, s.updated_at`;
  if (!chatBranchId) {
    return sql`(SELECT ${liveColumns} FROM pages_seo s WHERE true${idFilter("s.page_id", pageIds)})`;
  }
  // `o.seo IS NULL` covers both "no pending snapshot" (no `o` row) and "the
  // latest pending snapshot predates SEO on the page" — the live row stands.
  const pick = (field: string, column: string, cast: string): SQL =>
    sql.raw(
      `CASE WHEN o.seo IS NULL THEN s.${column} ELSE (o.seo->>'${field}')${cast} END AS ${column}`,
    );
  return sql`(
    SELECT COALESCE(s.page_id, o.page_id) AS page_id,
      ${pick("metaDescription", "meta_description", "")},
      ${pick("ogImageAssetId", "og_image_asset_id", "::uuid")},
      ${pick("canonicalUrl", "canonical_url", "")},
      ${pick("noindex", "noindex", "::boolean")},
      ${pick("changefreq", "changefreq", "")},
      ${pick("priority", "priority", "::numeric")},
      ${pick("autofilledAt", "autofilled_at", "::timestamptz")},
      ${pick("optimizedAt", "optimized_at", "::timestamptz")},
      CASE WHEN o.seo IS NULL THEN s.updated_at ELSE o.changed_at END AS updated_at
    FROM (SELECT ${liveColumns} FROM pages_seo s WHERE true${idFilter("s.page_id", pageIds)}) s
    FULL JOIN (
      SELECT DISTINCT ON (ps.page_id) ps.page_id, ps.state->'seo' AS seo, ss.created_at AS changed_at
      FROM page_snapshots ps
      JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
      WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}${idFilter("ps.page_id", pageIds)}
      ORDER BY ps.page_id, ss.created_at DESC, ps.id DESC
    ) o ON o.page_id = s.page_id
    WHERE s.page_id IS NOT NULL OR o.seo IS NOT NULL
  )`;
}

async function selectSeo(
  tx: TransactionRunner,
  from: SQL,
): Promise<Map<string, { state: PageSeoState; updatedAt: string }>> {
  const rows = (await tx.execute(sql`
    SELECT v.page_id::text AS page_id, v.meta_description,
           v.og_image_asset_id::text AS og_image_asset_id, v.canonical_url, v.noindex,
           v.changefreq, v.priority, v.autofilled_at, v.optimized_at, v.updated_at
    FROM ${from} v
  `)) as unknown as SeoViewRow[];
  return new Map(
    rows.map((r) => [r.page_id, { state: rowToState(r), updatedAt: iso(r.updated_at) }]),
  );
}

/** The live `pages_seo` state of each page that has a row. */
export async function loadLivePageSeo(
  tx: TransactionRunner,
  pageIds: readonly string[],
): Promise<Map<string, PageSeoState>> {
  const live = await selectSeo(tx, pageSeoViewSql(null, pageIds));
  return new Map([...live].map(([id, v]) => [id, v.state]));
}

/**
 * The SEO of each page in the caller's view, with the fields its branch
 * changed. Pages with no SEO row and no pending SEO change are absent
 * (they read as {@link PAGE_SEO_COLUMN_DEFAULTS}).
 */
export async function loadPageSeoViews(
  tx: TransactionRunner,
  pageIds: readonly string[],
  chatBranchId: string | null | undefined,
): Promise<Map<string, PageSeoView>> {
  const out = new Map<string, PageSeoView>();
  if (pageIds.length === 0) return out;
  const view = await selectSeo(tx, pageSeoViewSql(chatBranchId, pageIds));
  const live = chatBranchId ? await loadLivePageSeo(tx, pageIds) : null;
  for (const [pageId, v] of view) {
    out.set(pageId, {
      state: v.state,
      updatedAt: v.updatedAt,
      pendingFields: live ? changedSeoFields(live.get(pageId), v.state) : [],
    });
  }
  return out;
}

/** The SEO fields `next` changes against `base` (a missing row = the defaults). */
function changedSeoFields(base: PageSeoState | undefined, next: PageSeoState): PageSeoField[] {
  const from = base ?? PAGE_SEO_COLUMN_DEFAULTS;
  return PAGE_SEO_FIELDS.filter((f) => from[f] !== next[f]);
}

/**
 * Write a page's SEO state into the live `pages_seo` row (creating it).
 * The merge of a Stage, a revert and an out-of-chat write all land here,
 * so the live row always holds exactly a snapshot's state.
 */
export async function applyPageSeoState(
  tx: TransactionRunner,
  pageId: string,
  seo: PageSeoState,
  actorId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO pages_seo (page_id, meta_description, og_image_asset_id, canonical_url, noindex,
                           changefreq, priority, autofilled_at, optimized_at, updated_at, updated_by)
    VALUES (
      ${pageId}::uuid, ${seo.metaDescription},
      ${seo.ogImageAssetId === null ? null : sql`${seo.ogImageAssetId}::uuid`},
      ${seo.canonicalUrl}, ${seo.noindex}, ${seo.changefreq}, ${seo.priority},
      ${seo.autofilledAt === null ? null : sql`${seo.autofilledAt}::timestamptz`},
      ${seo.optimizedAt === null ? null : sql`${seo.optimizedAt}::timestamptz`},
      now(), ${actorId}::uuid
    )
    ON CONFLICT (page_id) DO UPDATE SET
      meta_description  = EXCLUDED.meta_description,
      og_image_asset_id = EXCLUDED.og_image_asset_id,
      canonical_url     = EXCLUDED.canonical_url,
      noindex           = EXCLUDED.noindex,
      changefreq        = EXCLUDED.changefreq,
      priority          = EXCLUDED.priority,
      autofilled_at     = EXCLUDED.autofilled_at,
      optimized_at      = EXCLUDED.optimized_at,
      updated_at        = now(),
      updated_by        = EXCLUDED.updated_by
  `);
}
