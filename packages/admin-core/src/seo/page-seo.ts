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

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { completeSeoOrigins, MAX_IMAGE_PREVIEW_VALUES, seoOriginsSchema } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { headOverlaySql } from "../draft.js";
import type { PageSeoState } from "../snapshots/state.js";
import { PAGE_SEO_HEAD_COLUMN_DEFAULTS } from "../snapshots/state-schemas.js";

/**
 * The `pages_seo` column defaults (migrations 0027, 0894), i.e. what a page
 * without a row reads as. Stored data's own shape, not a substitute value:
 * `INSERT INTO pages_seo (page_id)` produces exactly this.
 */
export const PAGE_SEO_COLUMN_DEFAULTS: PageSeoState = Object.freeze({
  ...PAGE_SEO_HEAD_COLUMN_DEFAULTS,
  metaDescription: "",
  ogImageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  changefreq: "weekly",
  priority: 0.5,
  autofilledAt: null,
  optimizedAt: null,
});

/**
 * The fields a pending SEO change can differ in, as `PageSeoState` keys:
 * what reaches the page. `origins` (who wrote a text) and the fill-once
 * markers are bookkeeping and never listed.
 */
export const PAGE_SEO_FIELDS = [
  "seoTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "ogImageAssetId",
  "canonicalUrl",
  "noindex",
  "nofollow",
  "noarchive",
  "nosnippet",
  "noimageindex",
  "maxSnippet",
  "maxImagePreview",
  "maxVideoPreview",
  "nosnippetContent",
  "changefreq",
  "priority",
] as const satisfies readonly (keyof PageSeoState)[];

/** Two values of one `PageSeoState` key are the same (arrays and `origins` by content). */
export function sameSeoValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return stableJson(a) === stableJson(b);
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The canonical form of a uuid in this module: Postgres prints uuids
 * lowercase, while a caller's (Zod-valid) uuid may be uppercase. Every
 * caller-supplied id — page or asset — goes through this before it is
 * compared, looked up or stored in a state, or a lookup misses (the caller
 * silently builds on the column defaults) and an unchanged value reads as
 * changed.
 */
export const uuidKey = (id: string): string => id.toLowerCase();

/** {@link uuidKey} for a page id (the key of every map these helpers return). */
export const pageKey = (id: string): string => uuidKey(id);

/** {@link uuidKey} for a nullable asset id (`null` = no OG image). */
export const assetKey = (id: string | null): string | null => (id === null ? null : uuidKey(id));

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
  seo_title: string;
  meta_description: string;
  og_title: string;
  og_description: string;
  og_image_asset_id: string | null;
  canonical_url: string | null;
  noindex: boolean;
  nofollow: boolean;
  noarchive: boolean;
  nosnippet: boolean;
  noimageindex: boolean;
  max_snippet: number | string | null;
  max_image_preview: string;
  max_video_preview: number | string | null;
  nosnippet_content: unknown;
  value_origins: unknown;
  changefreq: string;
  priority: number | string;
  autofilled_at: Date | string | null;
  optimized_at: Date | string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOpt = (v: Date | string | null): string | null => (v === null ? null : iso(v));
const intOpt = (v: number | string | null): number | null => (v === null ? null : Number(v));

const contentIdsSchema = z.array(z.string().uuid());
const maxImagePreviewSchema = z.enum(MAX_IMAGE_PREVIEW_VALUES);

/**
 * A row (or an overlaid pending state) as a `PageSeoState`. Its jsonb and
 * enum columns are validated: every write checks them, so a value that
 * fails here was written past the ops and is refused loudly, never read as
 * empty.
 */
function rowToState(r: SeoViewRow): PageSeoState {
  const content = contentIdsSchema.safeParse(r.nosnippet_content);
  const origins = seoOriginsSchema.safeParse(r.value_origins);
  const preview = maxImagePreviewSchema.safeParse(r.max_image_preview);
  if (!content.success || !origins.success || !preview.success) {
    throw new Error(
      `pages_seo of page ${r.page_id} holds values no op could have written (nosnippet_content, value_origins or max_image_preview) — set the page's SEO again with set_page_seo_many`,
    );
  }
  const texts = {
    seoTitle: r.seo_title,
    metaDescription: r.meta_description,
    ogTitle: r.og_title,
    ogDescription: r.og_description,
  };
  const autofilledAt = isoOpt(r.autofilled_at);
  const optimizedAt = isoOpt(r.optimized_at);
  return {
    ...texts,
    ogImageAssetId: r.og_image_asset_id,
    canonicalUrl: r.canonical_url,
    noindex: r.noindex,
    nofollow: r.nofollow,
    noarchive: r.noarchive,
    nosnippet: r.nosnippet,
    noimageindex: r.noimageindex,
    maxSnippet: intOpt(r.max_snippet),
    maxImagePreview: preview.data,
    maxVideoPreview: intOpt(r.max_video_preview),
    nosnippetContent: [...content.data].sort(),
    origins: completeSeoOrigins({ ...texts, origins: origins.data, autofilledAt, optimizedAt }),
    changefreq: r.changefreq,
    priority: Number(r.priority),
    autofilledAt,
    optimizedAt,
  };
}

const idFilter = (column: string, pageIds: readonly string[] | undefined): SQL =>
  pageIds === undefined ? sql`` : sql` AND ${sql.raw(column)} = ANY(${uuidArray(pageIds)})`;

/** The live `pages_seo` columns every view row carries, in this order. */
const LIVE_COLUMNS = sql.raw(`s.page_id, s.seo_title, s.meta_description, s.og_title,
    s.og_description, s.og_image_asset_id, s.canonical_url, s.noindex, s.nofollow, s.noarchive,
    s.nosnippet, s.noimageindex, s.max_snippet, s.max_image_preview, s.max_video_preview,
    s.nosnippet_content, s.value_origins, s.changefreq, s.priority, s.autofilled_at,
    s.optimized_at, s.updated_at`);

/**
 * A subquery with one row per page that has SEO in the caller's view —
 * the live `pages_seo` columns ({@link LIVE_COLUMNS}) with the branch's
 * pending SEO laid over them. Join it like the table it replaces; a page
 * without a row in it reads as {@link PAGE_SEO_COLUMN_DEFAULTS}.
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
  if (!chatBranchId) {
    return sql`(SELECT ${LIVE_COLUMNS} FROM pages_seo s WHERE true${idFilter("s.page_id", pageIds)})`;
  }
  // `o.seo IS NULL` covers both "no pending snapshot" (no `o` row) and "the
  // latest pending snapshot predates SEO on the page" — the live row stands.
  const pick = (field: string, column: string, cast: string): SQL =>
    sql.raw(
      `CASE WHEN o.seo IS NULL THEN s.${column} ELSE (o.seo->>'${field}')${cast} END AS ${column}`,
    );
  // #1752 — a pending state written before 0894 lacks the head fields: it
  // reads as their column defaults, exactly as its snapshot parse does
  // (PAGE_SEO_HEAD_COLUMN_DEFAULTS).
  const pickHead = (field: string, column: string, cast: string, absent: string): SQL =>
    sql.raw(
      `CASE WHEN o.seo IS NULL THEN s.${column} WHEN NOT (o.seo ? '${field}') THEN ${absent} ELSE (o.seo->>'${field}')${cast} END AS ${column}`,
    );
  const pickJson = (field: string, column: string, absent: string): SQL =>
    sql.raw(
      `CASE WHEN o.seo IS NULL THEN s.${column} ELSE COALESCE(o.seo->'${field}', '${absent}'::jsonb) END AS ${column}`,
    );
  return sql`(
    SELECT COALESCE(s.page_id, o.page_id) AS page_id,
      ${pickHead("seoTitle", "seo_title", "", "''")},
      ${pick("metaDescription", "meta_description", "")},
      ${pickHead("ogTitle", "og_title", "", "''")},
      ${pickHead("ogDescription", "og_description", "", "''")},
      ${pick("ogImageAssetId", "og_image_asset_id", "::uuid")},
      ${pick("canonicalUrl", "canonical_url", "")},
      ${pick("noindex", "noindex", "::boolean")},
      ${pickHead("nofollow", "nofollow", "::boolean", "false")},
      ${pickHead("noarchive", "noarchive", "::boolean", "false")},
      ${pickHead("nosnippet", "nosnippet", "::boolean", "false")},
      ${pickHead("noimageindex", "noimageindex", "::boolean", "false")},
      ${pickHead("maxSnippet", "max_snippet", "::integer", "NULL::integer")},
      ${pickHead("maxImagePreview", "max_image_preview", "", "'large'")},
      ${pickHead("maxVideoPreview", "max_video_preview", "::integer", "NULL::integer")},
      ${pickJson("nosnippetContent", "nosnippet_content", "[]")},
      ${pickJson("origins", "value_origins", "{}")},
      ${pick("changefreq", "changefreq", "")},
      ${pick("priority", "priority", "::numeric")},
      ${pick("autofilledAt", "autofilled_at", "::timestamptz")},
      ${pick("optimizedAt", "optimized_at", "::timestamptz")},
      CASE WHEN o.seo IS NULL THEN s.updated_at ELSE o.changed_at END AS updated_at
    FROM (SELECT ${LIVE_COLUMNS} FROM pages_seo s WHERE true${idFilter("s.page_id", pageIds)}) s
    FULL JOIN (
      SELECT h.entity_id::uuid AS page_id, h.seo, h.changed_at FROM (${headOverlaySql({
        kind: "page",
        table: "page_snapshots",
        branchId: chatBranchId,
        ...(pageIds ? { ids: pageIds } : {}),
        columns: sql`es.state->'seo' AS seo, d.header_created_at AS changed_at`,
      })}) h
    ) o ON o.page_id = s.page_id
    WHERE s.page_id IS NOT NULL OR o.seo IS NOT NULL
  )`;
}

async function selectSeo(
  tx: TransactionRunner,
  from: SQL,
): Promise<Map<string, { state: PageSeoState; updatedAt: string }>> {
  const rows = (await tx.execute(sql`
    SELECT v.page_id::text AS page_id, v.seo_title, v.meta_description, v.og_title,
           v.og_description, v.og_image_asset_id::text AS og_image_asset_id, v.canonical_url,
           v.noindex, v.nofollow, v.noarchive, v.nosnippet, v.noimageindex, v.max_snippet,
           v.max_image_preview, v.max_video_preview, v.nosnippet_content, v.value_origins,
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
  return PAGE_SEO_FIELDS.filter((f) => !sameSeoValue(from[f], next[f]));
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
  const jsonb = (v: unknown): SQL => sql`(${JSON.stringify(v)}::text)::jsonb`;
  await tx.execute(sql`
    INSERT INTO pages_seo (page_id, seo_title, meta_description, og_title, og_description,
                           og_image_asset_id, canonical_url, noindex, nofollow, noarchive,
                           nosnippet, noimageindex, max_snippet, max_image_preview,
                           max_video_preview, nosnippet_content, value_origins, changefreq,
                           priority, autofilled_at, optimized_at, updated_at, updated_by)
    VALUES (
      ${pageId}::uuid, ${seo.seoTitle}, ${seo.metaDescription}, ${seo.ogTitle},
      ${seo.ogDescription},
      ${seo.ogImageAssetId === null ? null : sql`${seo.ogImageAssetId}::uuid`},
      ${seo.canonicalUrl}, ${seo.noindex}, ${seo.nofollow}, ${seo.noarchive}, ${seo.nosnippet},
      ${seo.noimageindex}, ${seo.maxSnippet}, ${seo.maxImagePreview}, ${seo.maxVideoPreview},
      ${jsonb(seo.nosnippetContent)}, ${jsonb(seo.origins)}, ${seo.changefreq}, ${seo.priority},
      ${seo.autofilledAt === null ? null : sql`${seo.autofilledAt}::timestamptz`},
      ${seo.optimizedAt === null ? null : sql`${seo.optimizedAt}::timestamptz`},
      now(), ${actorId}::uuid
    )
    ON CONFLICT (page_id) DO UPDATE SET
      seo_title         = EXCLUDED.seo_title,
      meta_description  = EXCLUDED.meta_description,
      og_title          = EXCLUDED.og_title,
      og_description    = EXCLUDED.og_description,
      og_image_asset_id = EXCLUDED.og_image_asset_id,
      canonical_url     = EXCLUDED.canonical_url,
      noindex           = EXCLUDED.noindex,
      nofollow          = EXCLUDED.nofollow,
      noarchive         = EXCLUDED.noarchive,
      nosnippet         = EXCLUDED.nosnippet,
      noimageindex      = EXCLUDED.noimageindex,
      max_snippet       = EXCLUDED.max_snippet,
      max_image_preview = EXCLUDED.max_image_preview,
      max_video_preview = EXCLUDED.max_video_preview,
      nosnippet_content = EXCLUDED.nosnippet_content,
      value_origins     = EXCLUDED.value_origins,
      changefreq        = EXCLUDED.changefreq,
      priority          = EXCLUDED.priority,
      autofilled_at     = EXCLUDED.autofilled_at,
      optimized_at      = EXCLUDED.optimized_at,
      updated_at        = now(),
      updated_by        = EXCLUDED.updated_by
  `);
}
