// SPDX-License-Identifier: MPL-2.0

/**
 * `media.list_missing_files` — library assets whose stored files are gone.
 *
 * A media row can outlive its bytes: GCP installs before the media bucket
 * was mounted kept uploads on the Cloud Run container's ephemeral disk, so
 * every new revision or scale-to-zero dropped them while the rows stayed.
 * Stage then fails on the first such asset it copies. This read lists all
 * of them at once, with what the AI needs to restore each one (its source
 * URL when it was imported) or to take it off the pages that use it.
 *
 * Storage I/O inside the handler, like `media.regenerate_variants`: the
 * existence check needs the storage adapter, and the op is the boundary
 * that sees both the rows and the storage.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { buildMediaUrl, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getMediaStorage } from "../media/storage.js";

/** Storage existence checks in flight at once (each is a bucket round-trip on GCP). */
const CHECK_CONCURRENCY = 16;

const missingAsset = z.object({
  assetId: z.string(),
  slug: z.string(),
  name: z.string(),
  /** The asset's library URL (`/_caelo/media/<slug>`), as pages embed it. */
  url: z.string(),
  sourceKind: z.string().nullable(),
  /** For imported media: the URL it was downloaded from. */
  sourceDetail: z.string().nullable(),
  usageCount: z.number().int(),
  missingVariants: z.array(z.string()),
});

interface VariantDbRow {
  asset_id: string;
  slug: string;
  original_name: string;
  source_kind: string | null;
  source_detail: string | null;
  usage_count: number;
  variant: string;
  storage_key: string;
}

export const mediaListMissingFilesOp = defineOperation({
  name: "media.list_missing_files",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Report at most this many assets (most-used first). */
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  output: z.object({
    checkedAssets: z.number().int(),
    missingCount: z.number().int(),
    assets: z.array(missingAsset),
  }),
  handler: async (_ctx, input, tx) => {
    let storage: ReturnType<typeof getMediaStorage>;
    try {
      storage = getMediaStorage();
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "media.list_missing_files",
        message: (e as Error).message,
      });
    }
    const rows = (await tx.execute(sql`
      SELECT ma.id::text AS asset_id, ma.slug, ma.original_name, ma.source_kind,
             ma.source_detail, ma.usage_count, mv.variant, mv.storage_key
      FROM media_assets ma
      JOIN media_variants mv ON mv.asset_id = ma.id
      WHERE ma.deleted_at IS NULL
      ORDER BY ma.usage_count DESC, ma.created_at DESC, mv.variant
    `)) as unknown as VariantDbRow[];

    const absent: boolean[] = new Array(rows.length).fill(false);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        if (row) absent[i] = !(await storage.exists(row.storage_key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, rows.length) }, worker));

    const byAsset = new Map<string, z.infer<typeof missingAsset>>();
    const checked = new Set<string>();
    rows.forEach((row, i) => {
      checked.add(row.asset_id);
      if (!absent[i]) return;
      const asset = byAsset.get(row.asset_id) ?? {
        assetId: row.asset_id,
        slug: row.slug,
        name: row.original_name,
        url: buildMediaUrl(row.slug, "orig"),
        sourceKind: row.source_kind,
        sourceDetail: row.source_detail,
        usageCount: row.usage_count,
        missingVariants: [],
      };
      asset.missingVariants.push(row.variant);
      byAsset.set(row.asset_id, asset);
    });
    const missing = [...byAsset.values()];
    return ok({
      checkedAssets: checked.size,
      missingCount: missing.length,
      assets: missing.slice(0, input.limit),
    });
  },
});
