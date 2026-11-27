// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — a page's SEO head as its readers show it: the value each head tag
 * will carry and where it comes from (page, page type, site, inherited), in
 * the caller's view. `pages_seo.get` / `get_many` (the AI's `get_page_seo`)
 * and the editor's SEO panel read it from here; the build and the preview
 * resolve with the same `resolvePageSeoHead`, so what they show is what a
 * build ships.
 *
 * Also the placements of `data-nosnippet`: stored as the content instances
 * the placements show (a placement keeps its content when it moves), read
 * back as the block and position each sits at now.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import {
  type PageTypeSeo,
  pageTypeSeoSchema,
  type ResolvedPageSeoHead,
  resolvePageSeoHead,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { headOverlaySql } from "../draft.js";
import { loadListEntities } from "../lists/store.js";
import { loadPageLayoutStateWithBranchOverlay } from "../snapshots/load.js";
import type { PageSeoState } from "../snapshots/state.js";
import { PAGE_SEO_COLUMN_DEFAULTS } from "./page-seo.js";

/** The site-level head settings (`site_defaults`). */
export interface SiteSeoHeadSettings {
  readonly titleTemplate: string;
  readonly siteName: string | null;
}

/** Read the site's title template and name; the singleton row must exist. */
export async function loadSiteSeoHeadSettings(tx: TransactionRunner): Promise<SiteSeoHeadSettings> {
  const rows = (await tx.execute(sql`
    SELECT seo_title_template, site_name FROM site_defaults WHERE id = 1
  `)) as unknown as { seo_title_template: string; site_name: string | null }[];
  const r = rows[0];
  if (!r) {
    throw new Error(
      "site_defaults row (id=1) is missing — the cms_admin migrations did not seed it; run them, then read the page's SEO again",
    );
  }
  return { titleTemplate: r.seo_title_template, siteName: r.site_name };
}

/** What a page contributes to its head besides its SEO row. */
export interface HeadPage {
  readonly title: string;
  readonly shortTitle: string;
  readonly pageTypeId: string;
}

/**
 * Title, short title and page type of each page in the caller's view (its
 * branch's pending edit when there is one). Pages the caller cannot see, or
 * deleted ones, are absent.
 */
export async function loadHeadPages(
  tx: TransactionRunner,
  pageIds: readonly string[],
  chatBranchId: string | null | undefined,
): Promise<Map<string, HeadPage>> {
  const out = new Map<string, HeadPage>();
  if (pageIds.length === 0) return out;
  const visibility = chatBranchId
    ? sql`AND (chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title, short_title, page_type_id::text AS page_type_id
      FROM pages
     WHERE id = ANY(${uuidArray(pageIds)}) AND deleted_at IS NULL ${visibility}
  `)) as unknown as { id: string; title: string; short_title: string; page_type_id: string }[];
  for (const r of rows) {
    out.set(r.id, { title: r.title, shortTitle: r.short_title, pageTypeId: r.page_type_id });
  }
  if (chatBranchId && out.size > 0) {
    const pending = (await tx.execute(sql`
      SELECT h.entity_id AS page_id, h.state FROM (${headOverlaySql({
        kind: "page",
        table: "page_snapshots",
        branchId: chatBranchId,
        ids: [...out.keys()],
      })}) h
    `)) as unknown as {
      page_id: string;
      state: { title: string; shortTitle: string; pageTypeId: string; deletedAt: string | null };
    }[];
    for (const p of pending) {
      if (p.state.deletedAt) out.delete(p.page_id);
      else {
        out.set(p.page_id, {
          title: p.state.title,
          shortTitle: p.state.shortTitle,
          pageTypeId: p.state.pageTypeId,
        });
      }
    }
  }
  return out;
}

/** The SEO of each page type in the caller's view (absent = it adds nothing). */
export async function loadPageTypeSeo(
  tx: TransactionRunner,
  pageTypeIds: readonly string[],
  chatBranchId: string | null | undefined,
): Promise<Map<string, { readonly slug: string; readonly seo: PageTypeSeo | undefined }>> {
  const types = await loadListEntities(tx, "pageType", chatBranchId ?? null, {
    ids: [...new Set(pageTypeIds)],
  });
  return new Map(
    types.map((t) => [t.id, { slug: t.state.slug, seo: t.state.definition.seo }] as const),
  );
}

/** A resolved head with the page type it took its values from. */
export interface PageSeoHeadView {
  readonly head: ResolvedPageSeoHead;
  readonly pageTypeSlug: string;
}

/**
 * Resolve the SEO head of each page in the caller's view. `seo` holds each
 * page's SEO state (absent = the column defaults, as the build reads it).
 */
export async function resolvePageSeoHeads(
  tx: TransactionRunner,
  pageIds: readonly string[],
  seo: ReadonlyMap<string, PageSeoState>,
  chatBranchId: string | null | undefined,
): Promise<Map<string, PageSeoHeadView>> {
  const out = new Map<string, PageSeoHeadView>();
  const pages = await loadHeadPages(tx, pageIds, chatBranchId);
  if (pages.size === 0) return out;
  const site = await loadSiteSeoHeadSettings(tx);
  const types = await loadPageTypeSeo(
    tx,
    [...pages.values()].map((p) => p.pageTypeId),
    chatBranchId,
  );
  for (const [pageId, page] of pages) {
    const type = types.get(page.pageTypeId);
    if (!type) {
      throw new Error(
        `page ${pageId} has page type ${page.pageTypeId}, which this view does not have — read the page again (list_pages)`,
      );
    }
    const typeSeo = type.seo === undefined ? undefined : pageTypeSeoSchema.parse(type.seo);
    out.set(pageId, {
      head: resolvePageSeoHead({
        pageTitle: page.title,
        shortTitle: page.shortTitle,
        seo: seo.get(pageId) ?? PAGE_SEO_COLUMN_DEFAULTS,
        pageTypeSeo: typeSeo,
        site,
      }),
      pageTypeSlug: type.slug,
    });
  }
  return out;
}

/** A page placement as the AI and the panel address it. */
export interface PlacementAt {
  readonly blockName: string;
  readonly position: number;
}

/** Every placement of a page in the caller's view: where it sits → its content instance. */
async function placementsOf(
  tx: TransactionRunner,
  pageId: string,
  chatBranchId: string | null | undefined,
): Promise<{ readonly at: PlacementAt; readonly contentInstanceId: string }[]> {
  const layout = await loadPageLayoutStateWithBranchOverlay(tx, pageId, chatBranchId);
  return layout.blocks.flatMap((b) =>
    (b.placements ?? []).map((p, position) => ({
      at: { blockName: b.blockName, position },
      contentInstanceId: p.contentInstanceId,
    })),
  );
}

/**
 * The content instances of these placements, or the placements the page
 * does not have (with every placement it does have, for the next try).
 */
export async function nosnippetContentOf(
  tx: TransactionRunner,
  pageId: string,
  refs: readonly PlacementAt[],
  chatBranchId: string | null | undefined,
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  const placements = await placementsOf(tx, pageId, chatBranchId);
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const hit = placements.find(
      (p) => p.at.blockName === ref.blockName && p.at.position === ref.position,
    );
    if (hit) ids.push(hit.contentInstanceId);
    else unknown.push(`${ref.blockName}#${ref.position}`);
  }
  if (unknown.length > 0) {
    const have = placements.map((p) => `${p.at.blockName}#${p.at.position}`).join(", ") || "none";
    return {
      ok: false,
      message: `the page has no placement ${unknown.join(", ")} — its placements are ${have}. Nothing was written.`,
    };
  }
  return { ok: true, ids };
}

/**
 * Where the page's `data-nosnippet` content sits now. Content no placement
 * shows any more (the module was removed, its content forked) is left out:
 * it renders nowhere.
 */
export async function nosnippetPlacementsOf(
  tx: TransactionRunner,
  pageId: string,
  contentIds: readonly string[],
  chatBranchId: string | null | undefined,
): Promise<PlacementAt[]> {
  if (contentIds.length === 0) return [];
  const wanted = new Set(contentIds);
  return (await placementsOf(tx, pageId, chatBranchId))
    .filter((p) => wanted.has(p.contentInstanceId))
    .map((p) => p.at);
}
