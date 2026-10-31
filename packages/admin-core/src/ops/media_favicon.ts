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
 * a favicon needs it, and the bind is the one boundary that knows.
 * Additive and idempotent.
 *
 * Issue #1254 — sharp and storage never run inside a transaction. Making
 * a rendition is three steps: {@link planFaviconRendition} reads (short
 * transaction), {@link renderFaviconFile} decodes, resizes and stores the
 * file with no connection held, and {@link recordFaviconRendition} writes
 * the row after the file exists (short transaction, `ON CONFLICT DO
 * NOTHING`, so a concurrent maker of the same rendition wins and the file
 * — same key, same bytes — stays valid).
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
import { type PipelineOutputVariant, renderFaviconRendition } from "../media/pipeline.js";
import { getMediaStorage } from "../media/storage.js";
import { origStorageKey } from "./media_regenerate.js";

/** An asset whose favicon rendition is needed. */
export interface FaviconAsset {
  readonly id: string;
  readonly sha256: string;
  readonly mime: string;
}

/** A rendition still to make: where the original lives. */
export interface FaviconPlan {
  readonly asset: FaviconAsset;
  readonly origKey: string;
}

/**
 * Whether `asset` still needs its favicon rendition: null for ICO/SVG and
 * when the rendition exists. Throws when the original cannot be located.
 */
export async function planFaviconRendition(
  tx: TransactionRunner,
  asset: FaviconAsset,
): Promise<FaviconPlan | null> {
  if (!isRasterImageMime(asset.mime)) return null;
  const existing = (await tx.execute(sql`
    SELECT 1 AS present FROM media_variants
    WHERE asset_id = ${asset.id}::uuid AND variant = ${FAVICON_VARIANT} LIMIT 1
  `)) as unknown as { present: number }[];
  if (existing.length > 0) return null;
  return { asset, origKey: await origStorageKey(tx, asset.id) };
}

/**
 * Make and store the rendition's file. Call it with no transaction held:
 * it reads the original from storage, runs sharp and writes the result.
 * Throws with the reason when the original cannot be read or decoded.
 */
export async function renderFaviconFile(plan: FaviconPlan): Promise<PipelineOutputVariant> {
  const storage = getMediaStorage();
  const bytes = await storage.get(plan.origKey);
  const v = await renderFaviconRendition(plan.asset.sha256, bytes);
  await storage.put(v.storageKey, v.body, v.contentType);
  return v;
}

/**
 * Record the stored rendition's row.
 *
 * @returns whether this call wrote it (false when a concurrent maker did).
 */
export async function recordFaviconRendition(
  tx: TransactionRunner,
  asset: FaviconAsset,
  v: PipelineOutputVariant,
): Promise<boolean> {
  const inserted = (await tx.execute(sql`
    INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key)
    VALUES (${asset.id}::uuid, ${v.variant}, ${v.format}, ${v.width}, ${v.height}, ${v.sizeBytes}, ${v.storageKey})
    ON CONFLICT (asset_id, variant) DO NOTHING
    RETURNING 1 AS created
  `)) as unknown as { created: number }[];
  return inserted.length > 0;
}

/**
 * Create the favicon rendition of the ACTIVE theme's favicon (the one the
 * static generator links) when it is a raster image without one. Run by
 * `deploy.trigger` before the generator starts, so the generator (a
 * separate connection) sees the committed row.
 */
export const ensureActiveFaviconRenditionOp = defineOperation({
  name: "themes.ensure_favicon_rendition",
  readScope: "request",
  // Why every actor: it runs as part of whoever's Stage (human, the AI's
  // deploy_staging, the system's stage flow) and only derives data from
  // an image that actor's build already ships.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  // Issue #1254 — sharp and storage run between short transactions.
  transaction: "none",
  input: z.object({}).strict(),
  output: z.object({ created: z.boolean(), mediaId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const failure = (asset: { slug: string; mime: string }, e: unknown) =>
      err({
        kind: "HandlerError" as const,
        operation: "themes.ensure_favicon_rendition",
        message:
          `the theme favicon (media ${asset.slug}, ${asset.mime}) has no ${FAVICON_VARIANT} rendition and it could not be made from the stored original ` +
          `(${(e as Error).message.slice(0, 300)}). Next step: bind another favicon image (AI tool: set_theme_asset with slot "favicon"), or upload an .ico / .svg favicon, then Stage again.`,
      });
    const read = await tx.transaction(async (t) => {
      const rows = (await t.execute(sql`
        SELECT ma.id::text AS id, ma.sha256, ma.mime, ma.slug
        FROM themes t
        JOIN media_assets ma ON ma.id = t.favicon_media_id AND ma.deleted_at IS NULL
        WHERE t.is_active = true
        LIMIT 1
      `)) as unknown as { id: string; sha256: string; mime: string; slug: string }[];
      const asset = rows[0];
      if (!asset) return null;
      try {
        return { asset, plan: await planFaviconRendition(t, asset), error: null };
      } catch (e) {
        return { asset, plan: null, error: e };
      }
    });
    if (!read) return ok({ created: false, mediaId: null });
    const { asset, plan, error } = read;
    if (error !== null) return failure(asset, error);
    if (!plan) return ok({ created: false, mediaId: asset.id });
    let file: PipelineOutputVariant;
    try {
      file = await renderFaviconFile(plan);
    } catch (e) {
      return failure(asset, e);
    }
    const created = await tx.transaction(async (t) => {
      const wrote = await recordFaviconRendition(t, asset, file);
      if (wrote) {
        await recordAudit(t, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "themes.ensure_favicon_rendition",
          entityId: asset.id,
          input,
          succeeded: true,
          resultSummary: `created ${FAVICON_VARIANT} rendition of the theme favicon ${asset.slug}`,
        });
      }
      return wrote;
    });
    return ok({ created, mediaId: asset.id });
  },
});
