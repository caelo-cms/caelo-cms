// SPDX-License-Identifier: MPL-2.0

/**
 * The active theme as the preview composes it — moved out of `preview.ts`
 * (#1212) so the preview's page loader and genesis share it without
 * importing the op.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  type ComposeTheme,
  type ComposeThemeAsset,
  type ThemeDocument,
  themeFaviconRendition,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";

/**
 * v0.11.0 — load the currently-active themes row + apply chat-branch
 * overlay (theme_snapshots tagged with the caller's chat_branch_id
 * authoritatively replace live tokens for the preview render).
 *
 * Returns null when no active theme exists; the renderer skips the
 * <style data-source="theme"> tag entirely in that case (legacy
 * parity). The migration ensures at least one is_active row exists
 * post-install so this only fires before-the-migration tests.
 */
export async function loadActiveThemeForCompose(
  tx: TransactionRunner,
  chatBranchId: string | undefined,
): Promise<ComposeTheme | undefined> {
  const rows = (await tx.execute(sql`
    SELECT
      t.id::text                     AS id,
      t.tokens                       AS tokens,
      t.logo_media_id::text          AS logo_media_id,
      la.slug                        AS logo_slug,
      la.mime                        AS logo_mime,
      t.logo_dark_media_id::text     AS logo_dark_media_id,
      lda.slug                       AS logo_dark_slug,
      lda.mime                       AS logo_dark_mime,
      t.favicon_media_id::text       AS favicon_media_id,
      fa.slug                        AS favicon_slug,
      fa.mime                        AS favicon_mime,
      t.social_share_media_id::text  AS social_share_media_id,
      ssa.slug                       AS social_share_slug,
      ssa.mime                       AS social_share_mime
    FROM themes t
    LEFT JOIN media_assets la  ON la.id  = t.logo_media_id         AND la.deleted_at  IS NULL
    LEFT JOIN media_assets lda ON lda.id = t.logo_dark_media_id    AND lda.deleted_at IS NULL
    LEFT JOIN media_assets fa  ON fa.id  = t.favicon_media_id      AND fa.deleted_at  IS NULL
    LEFT JOIN media_assets ssa ON ssa.id = t.social_share_media_id AND ssa.deleted_at IS NULL
    WHERE t.is_active = true
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    tokens: unknown;
    logo_media_id: string | null;
    logo_slug: string | null;
    logo_mime: string | null;
    logo_dark_media_id: string | null;
    logo_dark_slug: string | null;
    logo_dark_mime: string | null;
    favicon_media_id: string | null;
    favicon_slug: string | null;
    favicon_mime: string | null;
    social_share_media_id: string | null;
    social_share_slug: string | null;
    social_share_mime: string | null;
  }>;
  const row = rows[0];
  if (!row) return undefined;
  let tokens: ThemeDocument =
    typeof row.tokens === "string"
      ? (JSON.parse(row.tokens) as ThemeDocument)
      : (row.tokens as ThemeDocument);

  // Branch overlay — most-recent theme_snapshots row for this branch
  // replaces live tokens.
  if (chatBranchId) {
    const branchRows = (await tx.execute(sql`
      SELECT state
      FROM theme_snapshots ts
      JOIN site_snapshots ss ON ss.id = ts.site_snapshot_id
      WHERE ts.theme_id = ${row.id}::uuid
        AND ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
      ORDER BY ss.created_at DESC
      LIMIT 1
    `)) as unknown as Array<{ state: unknown }>;
    const raw = branchRows[0]?.state;
    if (raw) {
      const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        tokens?: ThemeDocument;
        deletedAt?: string | null;
      };
      if (!parsed.deletedAt && parsed.tokens) tokens = parsed.tokens;
    }
  }

  // URL is built from the SLUG (public form); the id stays the mediaId.
  // A null slug means the bound asset was deleted — drop the binding
  // (slug and mime come from the same joined row, so they are null
  // together).
  const asset = (
    id: string | null,
    slug: string | null,
    mime: string | null,
  ): ComposeThemeAsset | null =>
    id === null || slug === null || mime === null
      ? null
      : { mediaId: id, url: buildMediaUrl(slug, "orig"), mime };
  return {
    tokens,
    assets: {
      logo: asset(row.logo_media_id, row.logo_slug, row.logo_mime),
      logoDark: asset(row.logo_dark_media_id, row.logo_dark_slug, row.logo_dark_mime),
      // Same rendition as the static generator: a raster favicon links its
      // small PNG, never the (often MB-sized) original.
      favicon:
        row.favicon_media_id === null || row.favicon_slug === null || row.favicon_mime === null
          ? null
          : {
              mediaId: row.favicon_media_id,
              ...themeFaviconRendition(row.favicon_slug, row.favicon_mime),
            },
      socialShare: asset(row.social_share_media_id, row.social_share_slug, row.social_share_mime),
    },
  };
}
