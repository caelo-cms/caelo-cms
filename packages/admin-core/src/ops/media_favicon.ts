// SPDX-License-Identifier: MPL-2.0

/**
 * The favicon rendition (`FAVICON_VARIANT`, a 64 px PNG) of a raster image
 * bound to the theme's favicon slot. Both render surfaces link it instead
 * of the original (`themeFaviconRendition`): an AI-generated 1024 px PNG
 * of 1-2 MB as `<link rel="icon">` is downloaded on every page load and,
 * under Lighthouse's throttled network, took the homepage's LCP from 0.9 s
 * to 4.7 s (real-AI run 39038927234).
 *
 * Created at bind time (`themes.set_asset`) rather than per upload: only
 * a favicon needs it, and the bind is the one boundary that knows. Sharp +
 * storage I/O inside the op's transaction, same rationale as
 * `media.regenerate_variants`: the variant row must be written together
 * with the bytes it points at. Additive and idempotent.
 *
 * A raster favicon bound before this rule has no rendition. Every Stage
 * runs `themes.ensure_favicon_rendition` before the generator, so such an
 * install upgrades without a manual step: the rendition is derived from
 * the stored original, written once, and audited. If the original cannot
 * be read or decoded the Stage fails with the reason (no fallback to the
 * original).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, FAVICON_VARIANT, isRasterImageMime, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { renderFaviconRendition } from "../media/pipeline.js";
import { getMediaStorage } from "../media/storage.js";
import { origStorageKey } from "./media_regenerate.js";

/**
 * Make sure a raster asset has its favicon rendition (no-op for ICO/SVG
 * and when it exists). Throws with the reason when the original bytes
 * cannot be read or decoded — the caller turns that into an error the AI
 * can act on.
 *
 * @param asset - the asset about to be bound as the favicon.
 * @returns whether this call created the rendition.
 */
export async function ensureFaviconRendition(
  tx: TransactionRunner,
  asset: { readonly id: string; readonly sha256: string; readonly mime: string },
): Promise<boolean> {
  if (!isRasterImageMime(asset.mime)) return false;
  const existing = (await tx.execute(sql`
    SELECT 1 AS present FROM media_variants
    WHERE asset_id = ${asset.id}::uuid AND variant = ${FAVICON_VARIANT} LIMIT 1
  `)) as unknown as { present: number }[];
  if (existing.length > 0) return false;
  const storage = getMediaStorage();
  const bytes = await storage.get(await origStorageKey(tx, asset.id));
  const v = await renderFaviconRendition(asset.sha256, bytes);
  await storage.put(v.storageKey, v.body, v.contentType);
  await tx.execute(sql`
    INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key)
    VALUES (${asset.id}::uuid, ${v.variant}, ${v.format}, ${v.width}, ${v.height}, ${v.sizeBytes}, ${v.storageKey})
    ON CONFLICT (asset_id, variant) DO NOTHING
  `);
  return true;
}

/**
 * Create the favicon rendition of the ACTIVE theme's favicon (the one the
 * static generator links) when it is a raster image without one. Run by
 * `deploy.trigger` in its own transaction before the generator starts, so
 * the generator (a separate connection) sees the committed row.
 */
export const ensureActiveFaviconRenditionOp = defineOperation({
  name: "themes.ensure_favicon_rendition",
  // Why every actor: it runs as part of whoever's Stage (human, the AI's
  // deploy_staging, the system's auto-redeploy) and only derives data from
  // an image that actor's build already ships.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ created: z.boolean(), mediaId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ma.id::text AS id, ma.sha256, ma.mime, ma.slug
      FROM themes t
      JOIN media_assets ma ON ma.id = t.favicon_media_id AND ma.deleted_at IS NULL
      WHERE t.is_active = true
      LIMIT 1
    `)) as unknown as { id: string; sha256: string; mime: string; slug: string }[];
    const asset = rows[0];
    if (!asset) return ok({ created: false, mediaId: null });
    let created: boolean;
    try {
      created = await ensureFaviconRendition(tx, asset);
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "themes.ensure_favicon_rendition",
        message:
          `the theme favicon (media ${asset.slug}, ${asset.mime}) has no ${FAVICON_VARIANT} rendition and it could not be made from the stored original ` +
          `(${(e as Error).message.slice(0, 300)}). Next step: bind another favicon image (AI tool: set_theme_asset with slot "favicon"), or upload an .ico / .svg favicon, then Stage again.`,
      });
    }
    if (created) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "themes.ensure_favicon_rendition",
        entityId: asset.id,
        input,
        succeeded: true,
        resultSummary: `created ${FAVICON_VARIANT} rendition of the theme favicon ${asset.slug}`,
      });
    }
    return ok({ created, mediaId: asset.id });
  },
});
