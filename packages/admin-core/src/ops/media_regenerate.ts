// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D4 — `media.regenerate_variants`. Recovery op for assets
 * whose derived WebP variants are missing: the staging generator
 * fails loudly (per CLAUDE.md §2) when module HTML references an
 * (asset, variant) pair that has no `media_variants` row, and before
 * this op NOTHING could mint variants after the fact — the only way
 * out of a blocked stage was re-importing the whole site.
 *
 * For each target asset the handler re-reads the ORIGINAL bytes from
 * storage, re-runs the same `runMediaPipeline` the upload endpoint and
 * `imports.migrate_media` use, persists any variant that does not
 * exist yet (additive only — existing rows are never touched), and
 * reports a per-asset result including WHY nothing new was produced
 * when the gap is by-design (source narrower than the breakpoint,
 * animated GIF, non-raster kind — see media/variant-gap.ts).
 *
 * Sharp + storage I/O inside a Query-API handler is deliberate here,
 * same rationale as `imports.migrate_media`: the variant rows must be
 * written atomically with the bytes' existence check, and the op is
 * the only boundary that sees both. Work is bounded by the 100-asset
 * input cap (assetIds mode) / the library scan cap (allMissing mode).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  err,
  MEDIA_ALLOWED_MIMES,
  type MediaMime,
  ok,
  pickAiImageVariant,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage } from "../media/storage.js";
import { computeVariantGap } from "../media/variant-gap.js";

/** allMissing mode scans at most this many raster assets per call. */
const ALL_MISSING_SCAN_CAP = 200;

const perAssetResult = z.object({
  assetId: z.string(),
  status: z.enum(["regenerated", "complete", "skipped", "failed", "not_found"]),
  /** Variant tags newly persisted by this run (empty unless `regenerated`). */
  addedVariants: z.array(z.string()),
  /** Human/AI-readable explanation for every non-`regenerated` status. */
  reason: z.string().nullable(),
  /** The URL AI should reference for this asset after the run. */
  bestUrl: z.string().nullable(),
});

interface AssetRow {
  id: string;
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
}

export const regenerateMediaVariantsOp = defineOperation({
  name: "media.regenerate_variants",
  // Routine + recoverable (additive-only writes; nothing is deleted or
  // overwritten), so the AI can unblock a failed stage without a human
  // round-trip — CLAUDE.md §11.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Explicit targets — use the ids from the generator's
       *  "media references unresolved" error. */
      assetIds: z.array(z.string().uuid()).min(1).max(100).optional(),
      /** Scan the library for raster assets whose expected ladder is
       *  incomplete and regenerate those. Mutually exclusive with assetIds. */
      allMissing: z.boolean().default(false),
    })
    .strict()
    .refine((v) => (v.assetIds !== undefined) !== v.allMissing, {
      message: "pass either assetIds or allMissing: true (exactly one)",
    }),
  output: z.object({ results: z.array(perAssetResult) }),
  handler: async (ctx, input, tx) => {
    // Fail loudly BEFORE any work when storage is not wired
    // (no-fallbacks pre-1.0) — same guard as imports.migrate_media.
    let storage: ReturnType<typeof getMediaStorage>;
    try {
      storage = getMediaStorage();
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "media.regenerate_variants",
        message: (e as Error).message,
      });
    }

    // ------------------------------------------------------------------
    // Resolve target assets.
    // ------------------------------------------------------------------
    const results: z.infer<typeof perAssetResult>[] = [];
    let targets: AssetRow[] = [];
    if (input.assetIds !== undefined) {
      for (const id of input.assetIds) {
        const rows = (await tx.execute(sql`
          SELECT id::text AS id, sha256, mime, width, height
          FROM media_assets WHERE id = ${id}::uuid AND deleted_at IS NULL LIMIT 1
        `)) as unknown as AssetRow[];
        if (rows[0]) {
          targets.push(rows[0]);
        } else {
          results.push({
            assetId: id,
            status: "not_found",
            addedVariants: [],
            reason: "no such media asset (deleted or wrong id) — list assets with media.list",
            bestUrl: null,
          });
        }
      }
    } else {
      // allMissing: scan raster assets (only rasters ever derive
      // variants) and keep those whose expected ladder is incomplete.
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, sha256, mime, width, height
        FROM media_assets
        WHERE deleted_at IS NULL AND mime IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
        ORDER BY created_at DESC
        LIMIT ${ALL_MISSING_SCAN_CAP}
      `)) as unknown as AssetRow[];
      targets = rows;
    }

    // ------------------------------------------------------------------
    // Per asset: diff expected-vs-existing, re-run the pipeline when a
    // gap is closable, persist only what's new.
    // ------------------------------------------------------------------
    let regeneratedCount = 0;
    for (const asset of targets) {
      const variantRows = (await tx.execute(sql`
        SELECT variant FROM media_variants WHERE asset_id = ${asset.id}::uuid
      `)) as unknown as { variant: string }[];
      const existing = new Set(variantRows.map((v) => v.variant));
      const gap = computeVariantGap({
        mime: asset.mime,
        width: asset.width,
        existingVariants: [...existing],
      });

      if (gap.missing.length === 0) {
        // Nothing regenerable. In allMissing mode complete assets are
        // simply not part of the report; in assetIds mode the caller
        // asked about THIS asset, so answer explicitly.
        if (input.assetIds !== undefined) {
          results.push({
            assetId: asset.id,
            status: gap.skipReason === null ? "complete" : "skipped",
            addedVariants: [],
            reason: gap.skipReason ?? "all expected variants are present",
            bestUrl: buildMediaUrl(asset.id, pickAiImageVariant([...existing])),
          });
        }
        continue;
      }

      try {
        if (!(MEDIA_ALLOWED_MIMES as readonly string[]).includes(asset.mime)) {
          throw new Error(`stored mime '${asset.mime}' is outside the media allowlist`);
        }
        const origKey = await origStorageKey(tx, asset.id);
        const bytes = await storage.get(origKey);
        const pipeline = await runMediaPipeline(asset.sha256, asset.mime as MediaMime, bytes);

        const added: string[] = [];
        for (const v of pipeline.variants) {
          if (existing.has(v.variant)) continue;
          await storage.put(v.storageKey, v.body, v.contentType);
          await tx.execute(sql`
            INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key)
            VALUES (${asset.id}::uuid, ${v.variant}, ${v.format}, ${v.width}, ${v.height}, ${v.sizeBytes}, ${v.storageKey})
          `);
          existing.add(v.variant);
          added.push(v.variant);
        }
        if (asset.width === null && pipeline.width !== null) {
          await tx.execute(sql`
            UPDATE media_assets SET width = ${pipeline.width}, height = ${pipeline.height}
            WHERE id = ${asset.id}::uuid
          `);
        }

        if (added.length > 0) regeneratedCount += 1;
        results.push({
          assetId: asset.id,
          status: added.length > 0 ? "regenerated" : "skipped",
          addedVariants: added,
          reason:
            added.length > 0
              ? null
              : "pipeline produced no additional variants (animated GIF, or source narrower than the remaining breakpoints) — reference an existing variant such as /orig in module HTML",
          bestUrl: buildMediaUrl(asset.id, pickAiImageVariant([...existing])),
        });
      } catch (e) {
        results.push({
          assetId: asset.id,
          status: "failed",
          addedVariants: [],
          reason: `regeneration failed: ${(e as Error).message.slice(0, 300)}`,
          bestUrl: null,
        });
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "media.regenerate_variants",
      input,
      succeeded: true,
      resultSummary: `targets=${targets.length} regenerated=${regeneratedCount} reported=${results.length}`,
    });

    return ok({ results });
  },
});

/** The `orig` row's storage key — the bytes every regeneration starts from. */
async function origStorageKey(tx: TransactionRunner, assetId: string): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT storage_key FROM media_variants
    WHERE asset_id = ${assetId}::uuid AND variant = 'orig' LIMIT 1
  `)) as unknown as { storage_key: string }[];
  const key = rows[0]?.storage_key;
  if (key) return key;
  // media_assets.storage_key duplicates the primary key (media.upload
  // stamps variants[0]); read it as the loud-error fallback source of
  // truth rather than guessing an extension from the mime.
  const assetRows = (await tx.execute(sql`
    SELECT storage_key FROM media_assets WHERE id = ${assetId}::uuid LIMIT 1
  `)) as unknown as { storage_key: string }[];
  const fallbackKey = assetRows[0]?.storage_key;
  if (!fallbackKey) {
    throw new Error("no 'orig' variant row and no asset storage_key — original bytes unlocatable");
  }
  return fallbackKey;
}
