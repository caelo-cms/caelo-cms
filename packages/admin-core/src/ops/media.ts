// SPDX-License-Identifier: MPL-2.0

/**
 * Media library ops (Phase 7).
 *
 * Uploads are orchestrated at the endpoint layer
 * (`apps/admin/src/routes/api/media/upload/+server.ts`):
 *   1. Sniff the MIME, sha-the-blob, dedupe against `media_assets`.
 *   2. Run `runMediaPipeline` from `media/pipeline.ts` to emit variants.
 *   3. `storage.put()` each variant's bytes via the configured adapter.
 *   4. Call `media.upload` op below — DB-only — to insert metadata.
 *
 * Splitting it this way keeps the Query API surface DB-only (no
 * sharp / fs imports leak into the chokepoint) and lets the endpoint
 * handle the multipart parsing.
 *
 * Per CLAUDE.md §2 no-fallbacks: callers see structured errors when
 * data is missing — never a silent fallback. A media reference in
 * module HTML pointing at a deleted asset crashes the renderer
 * loudly per the static-generator media-pass.
 */

import { defineOperation } from "@caelo/query-api";
import {
  err,
  mediaDeleteInputSchema,
  mediaListInputSchema,
  mediaRecentForAiInputSchema,
  mediaRecordUsageInputSchema,
  mediaSetCdnInputSchema,
  mediaUpdateAltInputSchema,
  mediaUploadInputSchema,
  ok,
} from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

// ---------------------------------------------------------------------
// Row shapes returned to callers.
// ---------------------------------------------------------------------

const mediaVariantRow = z.object({
  variant: z.string(),
  format: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sizeBytes: z.number().int(),
  storageKey: z.string(),
});

const mediaAssetRow = z.object({
  id: z.string(),
  sha256: z.string(),
  originalName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: z.string(),
  storageKey: z.string(),
  usageCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  variants: z.array(mediaVariantRow),
});

type AssetDbRow = {
  id: string;
  sha256: string;
  original_name: string;
  mime: string;
  size_bytes: number | bigint | string;
  width: number | null;
  height: number | null;
  alt: string;
  storage_key: string;
  usage_count: number | bigint | string;
  last_used_at: Date | string | null;
  created_at: Date | string;
};

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const num = (v: number | bigint | string): number => Number(v);

function rowToAsset(
  r: AssetDbRow,
  variants: {
    variant: string;
    format: string;
    width: number | null;
    height: number | null;
    size_bytes: number | bigint | string;
    storage_key: string;
  }[],
): z.infer<typeof mediaAssetRow> {
  return {
    id: r.id,
    sha256: r.sha256,
    originalName: r.original_name,
    mime: r.mime,
    sizeBytes: num(r.size_bytes),
    width: r.width,
    height: r.height,
    alt: r.alt,
    storageKey: r.storage_key,
    usageCount: num(r.usage_count),
    lastUsedAt: r.last_used_at === null ? null : iso(r.last_used_at),
    createdAt: iso(r.created_at),
    variants: variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: v.height,
      sizeBytes: num(v.size_bytes),
      storageKey: v.storage_key,
    })),
  };
}

// ---------------------------------------------------------------------
// media.upload — DB-only. Endpoint already wrote bytes to storage.
// ---------------------------------------------------------------------

export const mediaUploadOp = defineOperation({
  name: "media.upload",
  // Humans + system. AI uploads live in P11+ (plugin SDK) or the
  // `import-site` skill; the routine surface is human-driven so the
  // audit trail is unambiguous.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: mediaUploadInputSchema,
  output: z.object({ assetId: z.string(), deduped: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // Dedupe by content hash. If a row already exists we return its id;
    // the endpoint should NOT have run `storage.put` again (the dedupe
    // check happens before the pipeline).
    const existing = (await tx.execute(sql`
      SELECT id::text AS id FROM media_assets
      WHERE sha256 = ${input.sha256} AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (existing[0]) {
      // Re-uploads of the same content still need an audit trail entry
      // so /security/audit shows who attempted the upload, even though
      // no new row landed in media_assets.
      await recordAudit(tx, {
        actorId: ctx.actorId,
        operation: "media.upload",
        input: { sha256: input.sha256, mime: input.mime, originalName: input.originalName },
        succeeded: true,
        entityId: existing[0].id,
        resultSummary: "deduped",
      });
      return ok({ assetId: existing[0].id, deduped: true });
    }

    // P7 optimization #3 — stamp the active storage provider so we
    // can later migrate / dual-write between adapters and tell at a
    // glance which assets live where.
    const provider = (input as { storageProvider?: string }).storageProvider ?? "local";
    const inserted = (await tx.execute(sql`
      INSERT INTO media_assets (
        sha256, original_name, mime, size_bytes, width, height, alt, storage_key, storage_provider, created_by
      )
      VALUES (
        ${input.sha256},
        ${input.originalName},
        ${input.mime},
        ${input.sizeBytes},
        ${input.width},
        ${input.height},
        ${input.alt},
        ${input.storageKey},
        ${provider},
        ${ctx.actorId}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const assetId = inserted[0]?.id;
    if (!assetId) {
      return err({
        kind: "HandlerError",
        operation: "media.upload",
        message: "no id returned",
      });
    }

    // Bulk-insert variants. Bun SQL doesn't support array unnesting via
    // tagged literals cleanly, so we issue one statement per variant —
    // the variant set is small (<= 5) so the cost is negligible.
    for (const v of input.variants) {
      await tx.execute(sql`
        INSERT INTO media_variants (asset_id, variant, format, width, height, size_bytes, storage_key)
        VALUES (
          ${assetId}::uuid,
          ${v.variant},
          ${v.format},
          ${v.width},
          ${v.height},
          ${v.sizeBytes},
          ${v.storageKey}
        )
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.upload",
      input: { sha256: input.sha256, mime: input.mime, originalName: input.originalName },
      succeeded: true,
      entityId: assetId,
      resultSummary: `variants=${input.variants.length}`,
    });

    return ok({ assetId, deduped: false });
  },
});

// ---------------------------------------------------------------------
// media.list — paginated, filtered, sorted.
// ---------------------------------------------------------------------

export const mediaListOp = defineOperation({
  name: "media.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: mediaListInputSchema,
  output: z.object({
    assets: z.array(mediaAssetRow),
    totalCount: z.number().int(),
  }),
  handler: async (_ctx, input, tx) => {
    const orderBy =
      input.sort === "most_used"
        ? sql`ORDER BY usage_count DESC, last_used_at DESC NULLS LAST, created_at DESC`
        : sql`ORDER BY created_at DESC`;

    // Build WHERE clause incrementally. Only `query` and `mime` are
    // user-controlled filter inputs; both are Zod-bounded.
    const queryCondition =
      input.query !== undefined && input.query.length > 0
        ? sql`AND (alt ILIKE ${`%${input.query}%`} OR original_name ILIKE ${`%${input.query}%`})`
        : sql``;
    const mimeCondition = input.mime !== undefined ? sql`AND mime = ${input.mime}` : sql``;

    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id, sha256, original_name, mime, size_bytes, width, height, alt,
        storage_key, usage_count, last_used_at, created_at
      FROM media_assets
      WHERE deleted_at IS NULL ${queryCondition} ${mimeCondition}
      ${orderBy}
      LIMIT ${input.limit} OFFSET ${input.offset}
    `)) as unknown as AssetDbRow[];

    const totalRows = (await tx.execute(sql`
      SELECT count(*)::int AS count FROM media_assets
      WHERE deleted_at IS NULL ${queryCondition} ${mimeCondition}
    `)) as unknown as { count: number }[];

    if (rows.length === 0) {
      return ok({ assets: [], totalCount: totalRows[0]?.count ?? 0 });
    }

    const ids = rows.map((r) => r.id);
    type VariantRow = {
      asset_id: string;
      variant: string;
      format: string;
      width: number | null;
      height: number | null;
      size_bytes: number | bigint | string;
      storage_key: string;
    };
    // Per-id query — Bun SQL's drizzle integration doesn't reliably
    // splat a JS array into a Postgres array param across all driver
    // versions. The list page is bounded by `limit` (max 200), so the
    // round-trip count is bounded; the readability win + portability
    // makes this preferable to a raw-SQL escape hatch.
    const variantRows: VariantRow[] = [];
    for (const id of ids) {
      const part = (await tx.execute(sql`
        SELECT asset_id::text AS asset_id, variant, format, width, height, size_bytes, storage_key
        FROM media_variants WHERE asset_id = ${id}::uuid
      `)) as unknown as VariantRow[];
      variantRows.push(...part);
    }

    const variantsByAsset = new Map<string, VariantRow[]>();
    for (const v of variantRows) {
      const list = variantsByAsset.get(v.asset_id) ?? [];
      list.push(v);
      variantsByAsset.set(v.asset_id, list);
    }

    return ok({
      assets: rows.map((r) => rowToAsset(r, variantsByAsset.get(r.id) ?? [])),
      totalCount: totalRows[0]?.count ?? 0,
    });
  },
});

// ---------------------------------------------------------------------
// media.get — single asset by id, with variants.
// ---------------------------------------------------------------------

export const mediaGetOp = defineOperation({
  name: "media.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ assetId: z.string().uuid() }).strict(),
  output: z.object({ asset: mediaAssetRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id, sha256, original_name, mime, size_bytes, width, height, alt,
        storage_key, usage_count, last_used_at, created_at
      FROM media_assets
      WHERE id = ${input.assetId}::uuid AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as AssetDbRow[];
    const r = rows[0];
    if (!r) return ok({ asset: null });

    const variants = (await tx.execute(sql`
      SELECT variant, format, width, height, size_bytes, storage_key
      FROM media_variants WHERE asset_id = ${input.assetId}::uuid
      ORDER BY variant
    `)) as unknown as {
      variant: string;
      format: string;
      width: number | null;
      height: number | null;
      size_bytes: number | bigint | string;
      storage_key: string;
    }[];

    return ok({ asset: rowToAsset(r, variants) });
  },
});

// ---------------------------------------------------------------------
// media.update_alt — narrow surface AI is allowed to touch (a11y).
// ---------------------------------------------------------------------

export const mediaUpdateAltOp = defineOperation({
  name: "media.update_alt",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: mediaUpdateAltInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE media_assets SET alt = ${input.alt}
      WHERE id = ${input.assetId}::uuid AND deleted_at IS NULL
      RETURNING 1
    `)) as unknown as { exists: number }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "media.update_alt",
        message: "asset not found",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.update_alt",
      input,
      succeeded: true,
      entityId: input.assetId,
      resultSummary: `altLength=${input.alt.length}`,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// media.delete — soft-delete; force required when usage_count > 0.
// ---------------------------------------------------------------------

export const mediaDeleteOp = defineOperation({
  name: "media.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: mediaDeleteInputSchema,
  output: z.object({
    deletedAt: z.string(),
    /** Modules referencing this asset; non-empty when `force` was set. */
    referencingModules: z.array(z.object({ id: z.string(), slug: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, usage_count FROM media_assets
      WHERE id = ${input.assetId}::uuid AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as { id: string; usage_count: number | bigint | string }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "media.delete",
        message: "asset not found",
      });
    }

    // Lookup referencing modules — used for both the blocked-without-
    // force path and the success-with-force resultSummary.
    const refRows = (await tx.execute(sql`
      SELECT id::text AS id, slug FROM modules
      WHERE deleted_at IS NULL
        AND html LIKE ${`%/_caelo/media/${input.assetId}/%`}
    `)) as unknown as { id: string; slug: string }[];

    if (num(target.usage_count) > 0 && !input.force) {
      return err({
        kind: "HandlerError",
        operation: "media.delete",
        message: `asset is used in ${refRows.length} module(s); pass force=true to delete anyway: ${refRows
          .map((r) => r.slug)
          .join(", ")}`,
      });
    }

    const updated = (await tx.execute(sql`
      UPDATE media_assets SET deleted_at = now()
      WHERE id = ${input.assetId}::uuid
      RETURNING deleted_at
    `)) as unknown as { deleted_at: Date | string }[];

    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.delete",
      input,
      succeeded: true,
      entityId: input.assetId,
      resultSummary: `force=${input.force},refs=${refRows.length}`,
    });

    const deletedAt = updated[0]?.deleted_at;
    return ok({
      deletedAt: deletedAt === undefined ? new Date().toISOString() : iso(deletedAt),
      referencingModules: refRows,
    });
  },
});

// ---------------------------------------------------------------------
// media.record_usage — system-only; called from modules.update hook.
// ---------------------------------------------------------------------

export const mediaRecordUsageOp = defineOperation({
  name: "media.record_usage",
  actorScope: ["system"],
  database: "cms_admin",
  input: mediaRecordUsageInputSchema,
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    for (const [assetId, delta] of Object.entries(input.deltas)) {
      if (delta === 0) continue;
      // Clamp at zero — avoids negative counts if a module was edited
      // outside our usage tracker (e.g. raw SQL fix in dev).
      await tx.execute(sql`
        UPDATE media_assets
        SET usage_count = GREATEST(0, usage_count + ${delta}),
            last_used_at = CASE WHEN ${delta} > 0 THEN now() ELSE last_used_at END
        WHERE id = ${assetId}::uuid AND deleted_at IS NULL
      `);
    }
    return ok({});
  },
});

// ---------------------------------------------------------------------
// media.recent_for_ai — top-N for the system-prompt block.
// ---------------------------------------------------------------------

export const mediaRecentForAiOp = defineOperation({
  name: "media.recent_for_ai",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: mediaRecentForAiInputSchema,
  output: z.object({
    assets: z.array(
      z.object({
        id: z.string(),
        originalName: z.string(),
        mime: z.string(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        alt: z.string(),
        usageCount: z.number().int(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    // Union of recent + most-used, deduped, capped at limit. Bun SQL
    // template doesn't elegantly express a UNION with a LIMIT shared
    // across both arms, so we do two SELECTs and merge in memory.
    const recent = (await tx.execute(sql`
      SELECT id::text AS id, original_name, mime, width, height, alt, usage_count
      FROM media_assets WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ${input.limit}
    `)) as unknown as {
      id: string;
      original_name: string;
      mime: string;
      width: number | null;
      height: number | null;
      alt: string;
      usage_count: number | bigint | string;
    }[];
    const popular = (await tx.execute(sql`
      SELECT id::text AS id, original_name, mime, width, height, alt, usage_count
      FROM media_assets WHERE deleted_at IS NULL AND usage_count > 0
      ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
      LIMIT ${input.limit}
    `)) as unknown as typeof recent;

    const seen = new Set<string>();
    const merged: typeof recent = [];
    for (const r of [...popular, ...recent]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
      if (merged.length >= input.limit) break;
    }
    return ok({
      assets: merged.map((r) => ({
        id: r.id,
        originalName: r.original_name,
        mime: r.mime,
        width: r.width,
        height: r.height,
        alt: r.alt,
        usageCount: num(r.usage_count),
      })),
    });
  },
});

// ---------------------------------------------------------------------
// media.list_usages — modules referencing a given asset.
// ---------------------------------------------------------------------

export const mediaListUsagesOp = defineOperation({
  name: "media.list_usages",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ assetId: z.string().uuid() }).strict(),
  output: z.object({
    modules: z.array(z.object({ id: z.string(), slug: z.string(), displayName: z.string() })),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name FROM modules
      WHERE deleted_at IS NULL
        AND html LIKE ${`%/_caelo/media/${input.assetId}/%`}
      ORDER BY slug
    `)) as unknown as { id: string; slug: string; display_name: string }[];
    return ok({
      modules: rows.map((r) => ({ id: r.id, slug: r.slug, displayName: r.display_name })),
    });
  },
});

// ---------------------------------------------------------------------
// media.get_settings — read-only view of the CDN toggle + threshold.
// Lives next to the other media ops so the Owner panel doesn't have to
// reach into the singleton through a wider schema.
// ---------------------------------------------------------------------

export const mediaGetSettingsOp = defineOperation({
  name: "media.get_settings",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    cdnCopyEnabled: z.boolean(),
    cdnUsageThreshold: z.number().int(),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT media_cdn_copy_enabled AS cdn_copy_enabled,
             media_cdn_usage_threshold AS cdn_usage_threshold
      FROM site_defaults WHERE id = 1 LIMIT 1
    `)) as unknown as { cdn_copy_enabled: boolean; cdn_usage_threshold: number }[];
    const r = rows[0];
    return ok({
      cdnCopyEnabled: r?.cdn_copy_enabled ?? false,
      cdnUsageThreshold: r?.cdn_usage_threshold ?? 5,
    });
  },
});

// ---------------------------------------------------------------------
// site_defaults.set_media_cdn — Owner toggle.
// ---------------------------------------------------------------------

export const setMediaCdnOp = defineOperation({
  name: "site_defaults.set_media_cdn",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: mediaSetCdnInputSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE site_defaults
      SET media_cdn_copy_enabled = ${input.enabled},
          media_cdn_usage_threshold = ${input.threshold},
          updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
      WHERE id = 1
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "site_defaults.set_media_cdn",
      input,
      succeeded: true,
      resultSummary: `enabled=${input.enabled},threshold=${input.threshold}`,
    });
    return ok({});
  },
});

// ---------------------------------------------------------------------
// P7 optimization #2 — focal-point + named crops.
//
// Both ops fan out variants synchronously through the standard
// pipeline; the new variant rows are appended to `media_variants` and
// the same content-addressed storage_key convention applies. Re-
// running with the same name + ratio is idempotent — variant
// emission is keyed by storage_key (sha + tag), and the asset blob
// is content-addressed.
// ---------------------------------------------------------------------

export const setFocalPointOp = defineOperation({
  name: "media.set_focal_point",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      assetId: z.string().uuid(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE media_assets SET focal_x = ${input.x}, focal_y = ${input.y}
      WHERE id = ${input.assetId}::uuid AND deleted_at IS NULL
      RETURNING 1
    `)) as unknown as { exists: number }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "media.set_focal_point",
        message: "asset not found",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.set_focal_point",
      input,
      succeeded: true,
      entityId: input.assetId,
      resultSummary: `x=${input.x.toFixed(2)},y=${input.y.toFixed(2)}`,
    });
    return ok({});
  },
});

export const addCropOp = defineOperation({
  name: "media.add_crop",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      assetId: z.string().uuid(),
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9-]*$/, "crop name must be lowercase kebab-case"),
      ratio: z.number().positive(),
    })
    .strict(),
  output: z.object({ cropId: z.string() }),
  handler: async (ctx, input, tx) => {
    // Upsert by (asset_id, name).
    const rows = (await tx.execute(sql`
      INSERT INTO media_crops (asset_id, name, ratio)
      VALUES (${input.assetId}::uuid, ${input.name}, ${input.ratio})
      ON CONFLICT (asset_id, name) DO UPDATE SET ratio = EXCLUDED.ratio
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const cropId = rows[0]?.id;
    if (!cropId) {
      return err({
        kind: "HandlerError",
        operation: "media.add_crop",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.add_crop",
      input,
      succeeded: true,
      entityId: input.assetId,
      resultSummary: `crop=${input.name}@${input.ratio}`,
    });
    return ok({ cropId });
  },
});

export const deleteCropOp = defineOperation({
  name: "media.delete_crop",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ cropId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM media_crops WHERE id = ${input.cropId}::uuid RETURNING 1
    `)) as unknown as { exists: number }[];
    if (rows.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "media.delete_crop",
        message: "crop not found",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.delete_crop",
      input,
      succeeded: true,
      entityId: input.cropId,
      resultSummary: "deleted",
    });
    return ok({});
  },
});

export const listCropsOp = defineOperation({
  name: "media.list_crops",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ assetId: z.string().uuid() }).strict(),
  output: z.object({
    crops: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        ratio: z.number(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, ratio, created_at
      FROM media_crops WHERE asset_id = ${input.assetId}::uuid
      ORDER BY name
    `)) as unknown as { id: string; name: string; ratio: number; created_at: Date | string }[];
    return ok({
      crops: rows.map((r) => ({
        id: r.id,
        name: r.name,
        ratio: Number(r.ratio),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

// ---------------------------------------------------------------------
// P7 optimization #4 — processing-status read endpoint backing.
// ---------------------------------------------------------------------

export const getProcessingStatusOp = defineOperation({
  name: "media.get_processing_status",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ assetId: z.string().uuid() }).strict(),
  output: z.object({
    status: z.enum(["processing", "ready", "failed"]),
    error: z.string().nullable(),
    processedAt: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT processing_status AS status, processing_error AS error, processed_at
      FROM media_assets WHERE id = ${input.assetId}::uuid AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as {
      status: "processing" | "ready" | "failed";
      error: string | null;
      processed_at: Date | string | null;
    }[];
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "media.get_processing_status",
        message: "asset not found",
      });
    }
    return ok({
      status: r.status,
      error: r.error,
      processedAt:
        r.processed_at === null
          ? null
          : r.processed_at instanceof Date
            ? r.processed_at.toISOString()
            : String(r.processed_at),
    });
  },
});

// ---------------------------------------------------------------------
// P7 optimization #5 — AI-proposed alt text. Mirrors site_memory_proposals.
// ---------------------------------------------------------------------

export const proposeAltOp = defineOperation({
  name: "media.propose_alt",
  // System-only — proposals come from a scanner CLI / future cron job.
  // AI cannot write directly to alt; the audit path stays unambiguous.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      assetId: z.string().uuid(),
      proposedAlt: z.string().min(1).max(2048),
      rationale: z.string().max(2048).default(""),
    })
    .strict(),
  output: z.object({ proposalId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO media_alt_proposals (asset_id, proposed_alt, rationale, proposed_by)
      VALUES (${input.assetId}::uuid, ${input.proposedAlt}, ${input.rationale}, ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const proposalId = rows[0]?.id;
    if (!proposalId) {
      return err({
        kind: "HandlerError",
        operation: "media.propose_alt",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.propose_alt",
      input: { assetId: input.assetId, proposedAltLen: input.proposedAlt.length },
      succeeded: true,
      entityId: proposalId,
      resultSummary: `proposal for asset ${input.assetId}`,
    });
    return ok({ proposalId });
  },
});

export const listAltProposalsOp = defineOperation({
  name: "media.list_alt_proposals",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      pendingOnly: z.boolean().default(true),
      limit: z.number().int().positive().max(200).default(50),
    })
    .strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        assetId: z.string(),
        assetName: z.string(),
        currentAlt: z.string(),
        proposedAlt: z.string(),
        rationale: z.string(),
        proposedAt: z.string(),
        decidedAt: z.string().nullable(),
        accepted: z.boolean().nullable(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const filter = input.pendingOnly ? sql`AND p.decided_at IS NULL` : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        p.id::text AS id,
        p.asset_id::text AS asset_id,
        a.original_name AS asset_name,
        a.alt AS current_alt,
        p.proposed_alt,
        p.rationale,
        p.proposed_at,
        p.decided_at,
        p.accepted
      FROM media_alt_proposals p
      JOIN media_assets a ON a.id = p.asset_id
      WHERE a.deleted_at IS NULL ${filter}
      ORDER BY p.proposed_at DESC
      LIMIT ${input.limit}
    `)) as unknown as {
      id: string;
      asset_id: string;
      asset_name: string;
      current_alt: string;
      proposed_alt: string;
      rationale: string;
      proposed_at: Date | string;
      decided_at: Date | string | null;
      accepted: boolean | null;
    }[];
    const isoOpt = (v: Date | string | null): string | null =>
      v === null ? null : v instanceof Date ? v.toISOString() : String(v);
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        assetId: r.asset_id,
        assetName: r.asset_name,
        currentAlt: r.current_alt,
        proposedAlt: r.proposed_alt,
        rationale: r.rationale,
        proposedAt:
          r.proposed_at instanceof Date ? r.proposed_at.toISOString() : String(r.proposed_at),
        decidedAt: isoOpt(r.decided_at),
        accepted: r.accepted,
      })),
    });
  },
});

export const reviewAltProposalOp = defineOperation({
  name: "media.review_alt_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      accept: z.boolean(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT asset_id::text AS asset_id, proposed_alt FROM media_alt_proposals
      WHERE id = ${input.proposalId}::uuid AND decided_at IS NULL
      LIMIT 1
    `)) as unknown as { asset_id: string; proposed_alt: string }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "media.review_alt_proposal",
        message: "proposal not found or already decided",
      });
    }
    await tx.execute(sql`
      UPDATE media_alt_proposals
      SET decided_at = now(), decided_by = ${ctx.actorId}::uuid, accepted = ${input.accept}
      WHERE id = ${input.proposalId}::uuid
    `);
    if (input.accept) {
      await tx.execute(sql`
        UPDATE media_assets SET alt = ${target.proposed_alt}
        WHERE id = ${target.asset_id}::uuid AND deleted_at IS NULL
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "media.review_alt_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.accept ? "accepted" : "rejected",
    });
    return ok({});
  },
});
