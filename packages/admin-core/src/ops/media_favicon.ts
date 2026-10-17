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
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { FAVICON_VARIANT, isRasterImageMime } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
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
 */
export async function ensureFaviconRendition(
  tx: TransactionRunner,
  asset: { readonly id: string; readonly sha256: string; readonly mime: string },
): Promise<void> {
  if (!isRasterImageMime(asset.mime)) return;
  const existing = (await tx.execute(sql`
    SELECT 1 AS present FROM media_variants
    WHERE asset_id = ${asset.id}::uuid AND variant = ${FAVICON_VARIANT} LIMIT 1
  `)) as unknown as { present: number }[];
  if (existing.length > 0) return;
  const storage = getMediaStorage();
  const bytes = await storage.get(await origStorageKey(tx, asset.id));
  const v = await renderFaviconRendition(asset.sha256, bytes);
  await storage.put(v.storageKey, v.body, v.contentType);
  await tx.execute(sql`
    INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key)
    VALUES (${asset.id}::uuid, ${v.variant}, ${v.format}, ${v.width}, ${v.height}, ${v.sizeBytes}, ${v.storageKey})
  `);
}
