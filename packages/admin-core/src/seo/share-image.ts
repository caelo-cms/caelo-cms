// SPDX-License-Identifier: MPL-2.0

/**
 * #1452 — which social-share image a page really gets, for every surface
 * that shows a page before it is built: the editor preview, `get_page_seo`
 * and the editor's SEO info. The static generator applies the same rule
 * (`pickShareImage`) in its SEO pass.
 *
 * The site default is the active theme's `socialShare` slot, read raw: an
 * asset deleted after binding then reads as a level with no URL here, and
 * stops the build there, instead of quietly dropping to no image.
 */

import type { RenderScope } from "@caelo-cms/plugin-host";
import { resolveShareImages } from "@caelo-cms/plugin-host";
import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { buildMediaUrl, pickShareImage, type ShareImageSource } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** A page's share image as a surface shows it. */
export interface PageShareImage {
  readonly source: ShareImageSource;
  /** The asset the build would publish; null only when `source` is `none`. */
  readonly assetId: string | null;
  /**
   * The image's `/_caelo/media` URL (the build rewrites it to `/_assets`).
   * Null with an `assetId` when the asset was deleted or has no variants:
   * the next Stage stops on it.
   */
  readonly url: string | null;
}

/** Runs a read in one short transaction (an op's `reads.read` / `tx.transaction`). */
export type ShortRead = <T>(fn: (tx: TransactionRunner) => Promise<T>) => Promise<T>;

/** The media asset bound to the active theme's `socialShare` slot, or null. */
async function loadSiteShareImageAssetId(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT social_share_media_id::text AS asset_id FROM themes WHERE is_active = true LIMIT 1
  `)) as unknown as { asset_id: string | null }[];
  return rows[0]?.asset_id ?? null;
}

/** Each live asset's best social-size rendition, the same order the build picks in. */
async function loadShareImageUrls(
  tx: TransactionRunner,
  assetIds: readonly string[],
): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (mv.asset_id)
      mv.asset_id::text AS asset_id, mv.variant AS variant, ma.slug AS slug
    FROM media_variants mv
    JOIN media_assets ma ON ma.id = mv.asset_id AND ma.deleted_at IS NULL
    WHERE mv.asset_id = ANY(${uuidArray(assetIds)})
    ORDER BY mv.asset_id,
      CASE mv.variant
        WHEN 'webp-1200' THEN 0 WHEN 'webp-1600' THEN 1
        WHEN 'webp-800'  THEN 2 WHEN 'orig'      THEN 3 ELSE 4
      END
  `)) as unknown as { asset_id: string; variant: string; slug: string }[];
  return new Map(rows.map((r) => [r.asset_id, buildMediaUrl(r.slug, r.variant)]));
}

/**
 * Resolve the share image of each page. Holds no transaction while plugins
 * answer (#1212): the reads run through `read`, the plugin call between them.
 *
 * @param pages each page with its own image in the caller's view.
 * @param scope the render's branch; a scope with `onPluginFailure` degrades
 *   a failing plugin to the site default, one without it throws.
 * @returns a map with an entry for every page.
 */
export async function resolvePageShareImages(
  read: ShortRead,
  pages: readonly { readonly pageId: string; readonly ownAssetId: string | null }[],
  scope: RenderScope,
): Promise<Map<string, PageShareImage>> {
  const site = await read(loadSiteShareImageAssetId);
  const language = await resolveShareImages(
    pages.filter((p) => p.ownAssetId === null).map((p) => p.pageId),
    scope,
  );
  const picks = pages.map((p) => ({
    pageId: p.pageId,
    ...pickShareImage({
      page: p.ownAssetId,
      language: language.get(p.pageId) ?? null,
      site,
    }),
  }));
  const assetIds = [...new Set(picks.flatMap((p) => (p.assetId === null ? [] : [p.assetId])))];
  const urls = await read((tx) => loadShareImageUrls(tx, assetIds));
  return new Map(
    picks.map((p) => [
      p.pageId,
      {
        source: p.source,
        assetId: p.assetId,
        url: p.assetId === null ? null : (urls.get(p.assetId) ?? null),
      },
    ]),
  );
}
