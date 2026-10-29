// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — every page with its type, properties and terms, as the
 * caller sees the site: live rows (main plus rows the branch created),
 * each superseded by the branch's newest pending page snapshot. Page
 * types (re-validating a type's pages), list usage (tagged pages) and the
 * render-data loader read pages through here so they agree with the
 * preview.
 *
 * Split in two (#1212): {@link loadPageRows} reads the rows and the
 * branch's pending page states, {@link pagesInViewOf} applies them. The
 * preview's cached site view (`site-view.ts`) keeps the rows and derives
 * this view, the page tree and the link targets from the same read.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../draft.js";
import type { PageState } from "../snapshots/state.js";

/** One page in the caller's view. */
export interface PageInView {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly currentPath: string;
  readonly parentPageId: string | null;
  readonly templateId: string;
  readonly pageTypeId: string;
  readonly status: "draft" | "published";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly terms: readonly string[];
  readonly version: number;
  readonly firstPublishedAt: string | null;
  readonly updatedAt: string;
}

/** One live `pages` row visible to the branch (deleted ones included). */
export interface PageRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly short_title: string;
  readonly current_path: string;
  readonly parent_page_id: string | null;
  readonly template_id: string;
  readonly page_type_id: string;
  readonly status: "draft" | "published";
  readonly properties: unknown;
  readonly version: number | string;
  readonly first_published_at: string | Date | null;
  readonly updated_at: string | Date;
  readonly deleted_at: string | Date | null;
  /** Live-row namespace: null = main, else the creating chat's branch. */
  readonly chat_branch_id: string | null;
  readonly terms: string[];
}

/** The rows a branch view of the pages is built from. */
export interface PageRows {
  /** Ordered by current path, then id. */
  readonly rows: readonly PageRow[];
  /** The branch's newest pending state per page (empty on main). */
  readonly pending: ReadonlyMap<string, PageState>;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Read every page row the branch sees (main plus the branch's own,
 * soft-deleted ones included: a pending snapshot may restore them) and
 * the branch's newest pending page state per page. Two queries.
 */
export async function loadPageRows(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<PageRows> {
  const visible = branchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS id, p.slug, p.title, p.short_title, p.current_path,
           p.parent_page_id::text AS parent_page_id, p.template_id::text AS template_id,
           p.page_type_id::text AS page_type_id, p.status, p.properties, p.version,
           p.first_published_at, p.updated_at, p.deleted_at,
           p.chat_branch_id::text AS chat_branch_id,
           COALESCE((
             SELECT array_agg('caelo:term/' || pt.list_id::text || '/' || pt.item_id::text
                              ORDER BY pt.created_at, pt.list_id, pt.item_id)
             FROM page_terms pt WHERE pt.page_id = p.id
           ), '{}') AS terms
    FROM pages p
    WHERE ${visible}
    ORDER BY p.current_path, p.id
  `)) as unknown as PageRow[];
  const pending = new Map<string, PageState>();
  if (branchId) {
    const snaps = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const s of snaps) {
      pending.set(s.page_id, s.state as PageState);
    }
  }
  return { rows, pending };
}

/**
 * The non-deleted pages of `rows` with their pending states applied.
 *
 * @param opts.pageTypeIds restrict to pages of these types (in the view).
 */
export function pagesInViewOf(
  { rows, pending }: PageRows,
  opts: { readonly pageTypeIds?: readonly string[] } = {},
): PageInView[] {
  const out: PageInView[] = [];
  for (const r of rows) {
    const o = pending.get(r.id);
    const deleted = o ? o.deletedAt !== null : r.deleted_at !== null;
    if (deleted) continue;
    const liveProps = r.properties;
    const page: PageInView = {
      id: r.id,
      slug: o?.slug ?? r.slug,
      title: o?.title ?? r.title,
      shortTitle: o?.shortTitle ?? r.short_title,
      currentPath: r.current_path,
      parentPageId: o?.parentPageId === undefined ? r.parent_page_id : o.parentPageId,
      templateId: o?.templateId ?? r.template_id,
      pageTypeId: o?.pageTypeId ?? r.page_type_id,
      status: o?.status ?? r.status,
      properties: o?.properties ?? ((liveProps ?? {}) as Record<string, unknown>),
      terms: o?.terms ?? r.terms,
      version:
        o?.version ?? (typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version),
      firstPublishedAt: iso(r.first_published_at),
      updatedAt: iso(r.updated_at) ?? "",
    };
    if (opts.pageTypeIds && !opts.pageTypeIds.includes(page.pageTypeId)) continue;
    out.push(page);
  }
  return out;
}

/**
 * Non-deleted pages the caller sees.
 *
 * @param opts.pageTypeIds restrict to pages of these types (in the view).
 */
export async function loadPagesInView(
  tx: TransactionRunner,
  branchId: string | null,
  opts: { readonly pageTypeIds?: readonly string[] } = {},
): Promise<PageInView[]> {
  return pagesInViewOf(await loadPageRows(tx, branchId), opts);
}
