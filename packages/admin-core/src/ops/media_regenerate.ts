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
 * Issue #1254 — no transaction is held while sharp or storage run: the
 * op is detached (`transaction: "none"`). One short transaction reads
 * every target and its existing variants; then, per asset, the original
 * is read, the pipeline runs and the new files are stored with no
 * connection held; a second short transaction records the new rows. A
 * row is written only after its file exists, only while the asset is
 * still live, and `ON CONFLICT DO NOTHING`: a concurrent run that
 * recorded the same variant first wins (its file has the same key and
 * the same bytes). Work is bounded by the 100-asset input cap (assetIds
 * mode) / the library scan cap (allMissing mode).
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
import { type PipelineResult, runMediaPipeline } from "../media/pipeline.js";
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
type PerAssetResult = z.infer<typeof perAssetResult>;

interface AssetRow {
  id: string;
  slug: string;
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
}

/** One target as the first short transaction read it. */
interface PlannedAsset {
  readonly asset: AssetRow;
  readonly existing: ReadonlySet<string>;
  readonly gap: ReturnType<typeof computeVariantGap>;
  /** The original's storage key, or why it cannot be located. Null when nothing is missing. */
  readonly orig: { readonly key: string } | { readonly error: string } | null;
}

export const regenerateMediaVariantsOp = defineOperation({
  name: "media.regenerate_variants",
  readScope: "request",
  // Routine + recoverable (additive-only writes; nothing is deleted or
  // overwritten), so the AI can unblock a failed stage without a human
  // round-trip — CLAUDE.md §11.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  // Issue #1254 — sharp and storage run between short transactions.
  transaction: "none",
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

    const results: PerAssetResult[] = [];
    const planned = await tx.transaction(async (t) => {
      const { targets, notFound } = await resolveTargets(t, input);
      results.push(...notFound);
      const out: PlannedAsset[] = [];
      for (const asset of targets) out.push(await planAsset(t, asset));
      return out;
    });

    let regeneratedCount = 0;
    for (const { asset, existing, gap, orig } of planned) {
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
            bestUrl: buildMediaUrl(asset.slug, pickAiImageVariant([...existing])),
          });
        }
        continue;
      }

      try {
        if (!(MEDIA_ALLOWED_MIMES as readonly string[]).includes(asset.mime)) {
          throw new Error(`stored mime '${asset.mime}' is outside the media allowlist`);
        }
        if (orig === null || "error" in orig) {
          throw new Error(orig?.error ?? "original bytes unlocatable");
        }
        // No transaction is held from here to the record step.
        const bytes = await storage.get(orig.key);
        const pipeline = await runMediaPipeline(asset.sha256, asset.mime as MediaMime, bytes);
        const fresh = pipeline.variants.filter((v) => !existing.has(v.variant));
        for (const v of fresh) await storage.put(v.storageKey, v.body, v.contentType);

        const added = await tx.transaction((t) => recordVariants(t, asset, fresh, pipeline));
        if (added === null) {
          results.push({
            assetId: asset.id,
            status: "not_found",
            addedVariants: [],
            reason:
              "the asset was deleted while its variants were being made — nothing was recorded; list assets with media.list",
            bestUrl: null,
          });
          continue;
        }
        const present = new Set([...existing, ...fresh.map((v) => v.variant)]);
        if (added.length > 0) regeneratedCount += 1;
        results.push({
          assetId: asset.id,
          status: added.length > 0 ? "regenerated" : "skipped",
          addedVariants: added,
          reason:
            added.length > 0
              ? null
              : fresh.length > 0
                ? "another run recorded these variants at the same time — nothing more was needed"
                : "pipeline produced no additional variants (animated GIF, or source narrower than the remaining breakpoints) — reference an existing variant such as /orig in module HTML",
          bestUrl: buildMediaUrl(asset.slug, pickAiImageVariant([...present])),
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

    await tx.transaction((t) =>
      recordAudit(t, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "media.regenerate_variants",
        input,
        succeeded: true,
        resultSummary: `targets=${planned.length} regenerated=${regeneratedCount} reported=${results.length}`,
      }),
    );

    return ok({ results });
  },
});

/** The live target assets, plus a `not_found` entry for every unknown explicit id. */
async function resolveTargets(
  tx: TransactionRunner,
  input: { readonly assetIds?: readonly string[] | undefined; readonly allMissing: boolean },
): Promise<{ targets: AssetRow[]; notFound: PerAssetResult[] }> {
  if (input.assetIds === undefined) {
    // allMissing: scan raster assets (only rasters ever derive variants)
    // and keep those whose expected ladder is incomplete.
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, sha256, mime, width, height
      FROM media_assets
      WHERE deleted_at IS NULL AND mime IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
      ORDER BY created_at DESC
      LIMIT ${ALL_MISSING_SCAN_CAP}
    `)) as unknown as AssetRow[];
    return { targets: rows, notFound: [] };
  }
  const targets: AssetRow[] = [];
  const notFound: PerAssetResult[] = [];
  for (const id of input.assetIds) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, sha256, mime, width, height
      FROM media_assets WHERE id = ${id}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as AssetRow[];
    if (rows[0]) {
      targets.push(rows[0]);
    } else {
      notFound.push({
        assetId: id,
        status: "not_found",
        addedVariants: [],
        reason: "no such media asset (deleted or wrong id) — list assets with media.list",
        bestUrl: null,
      });
    }
  }
  return { targets, notFound };
}

/** What one asset is missing, and where its original lives when that matters. */
async function planAsset(tx: TransactionRunner, asset: AssetRow): Promise<PlannedAsset> {
  const variantRows = (await tx.execute(sql`
    SELECT variant FROM media_variants WHERE asset_id = ${asset.id}::uuid
  `)) as unknown as { variant: string }[];
  const existing = new Set(variantRows.map((v) => v.variant));
  const gap = computeVariantGap({
    mime: asset.mime,
    width: asset.width,
    existingVariants: [...existing],
  });
  if (gap.missing.length === 0) return { asset, existing, gap, orig: null };
  try {
    return { asset, existing, gap, orig: { key: await origStorageKey(tx, asset.id) } };
  } catch (e) {
    return { asset, existing, gap, orig: { error: (e as Error).message } };
  }
}

/**
 * Record the stored variants of a still-live asset. A variant another run
 * recorded first is left as it is (same key, same bytes).
 *
 * @returns the variants this call added, or null when the asset was
 *   deleted meanwhile (nothing is written then).
 */
async function recordVariants(
  tx: TransactionRunner,
  asset: AssetRow,
  variants: PipelineResult["variants"],
  pipeline: Pick<PipelineResult, "width" | "height">,
): Promise<string[] | null> {
  const live = (await tx.execute(sql`
    SELECT 1 AS live FROM media_assets WHERE id = ${asset.id}::uuid AND deleted_at IS NULL
  `)) as unknown as { live: number }[];
  if (live.length === 0) return null;
  const added: string[] = [];
  for (const v of variants) {
    const inserted = (await tx.execute(sql`
      INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key,
                                  content_sha256, gzip_sha256, gzip_size, digest_profile)
      VALUES (${asset.id}::uuid, ${v.variant}, ${v.format}, ${v.width}, ${v.height}, ${v.sizeBytes}, ${v.storageKey},
              ${v.digest.contentSha256}, ${v.digest.gzipSha256}, ${v.digest.gzipSize}, ${v.digest.profile})
      ON CONFLICT (asset_id, variant) DO NOTHING
      RETURNING variant
    `)) as unknown as { variant: string }[];
    if (inserted.length > 0) added.push(v.variant);
  }
  if (asset.width === null && pipeline.width !== null) {
    // Only while the asset still has no dimensions: a concurrent run or an
    // edit that set them keeps its values.
    await tx.execute(sql`
      UPDATE media_assets SET width = ${pipeline.width}, height = ${pipeline.height}
      WHERE id = ${asset.id}::uuid AND width IS NULL
    `);
  }
  return added;
}

/** The `orig` row's storage key — the bytes every regeneration starts from. */
export async function origStorageKey(tx: TransactionRunner, assetId: string): Promise<string> {
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
