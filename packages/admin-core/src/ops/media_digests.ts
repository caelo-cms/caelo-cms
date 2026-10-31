// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — the backfill and the rebuild of the stored media digests
 * (`media_variants.content_sha256 / gzip_sha256 / gzip_size /
 * digest_profile`, migration 0452).
 *
 * Every write path stores them with the variant; this op computes them for
 * the rows that have none — written before 0452, or by the previous
 * release during an upgrade — and, in `scope: "all"`, recomputes every row
 * and reports what was wrong (maintenance after a file was replaced outside
 * Caelo). System-only: nothing asks a person or the AI to run it. `deploy.trigger` runs it with `scope: "missing"` before the
 * generator starts, the way it creates a missing favicon rendition, so an
 * upgraded install needs no manual step and the build never reads a media
 * file to name it.
 *
 * Step-wise (#1211): the rows are listed in one short transaction, the
 * files are read outside any transaction (a stream each, a bounded number
 * at once — gcsfuse latency, not memory), and the digests are written in
 * another short transaction, each only if the row still names the same
 * storage key (a concurrent rewrite wins).
 */

import { Readable } from "node:stream";
import {
  type DatabaseAdapter,
  defineOperation,
  defineStepwiseOperation,
  execute,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, runBatched } from "@caelo-cms/shared";
import { digestProfile, digestStream, type PublishedDigest } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { recordAudit } from "../audit.js";
import { getMediaStorage } from "../media/storage.js";
import { jsonbParam } from "../sql-helpers.js";

/** Files digested at once: storage reads are I/O-bound (gcsfuse), each a stream. */
const DIGEST_PARALLELISM = 16;
/** Rows per write statement. */
const WRITE_BATCH = 500;

const targetRow = z.object({
  assetId: z.string(),
  slug: z.string(),
  variant: z.string(),
  storageKey: z.string(),
  stored: z
    .object({
      contentSha256: z.string(),
      gzipSha256: z.string(),
      gzipSize: z.number().int(),
      profile: z.string(),
    })
    .nullable(),
});
type TargetRow = z.infer<typeof targetRow>;

const scopeInput = z
  .object({
    /**
     * `missing` (default): rows without digests or with another gzip
     * profile's. `all`: every row of a live asset, recomputed and compared.
     */
    scope: z.enum(["missing", "all"]).default("missing"),
    /** Only these assets (any scope). */
    assetIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .strict();

/** Step 1 of media.rebuild_digests: the rows to digest. */
export const listDigestTargetsOp = defineOperation({
  name: "media.list_digest_targets",
  // Why system-only: a step of media.rebuild_digests (system-only, below).
  actorScope: ["system"],
  // Why site-wide: the backfill's purpose is every media row without digests.
  readScope: "site",
  database: "cms_admin",
  input: scopeInput.extend({ profile: z.string().min(1) }),
  output: z.object({ targets: z.array(targetRow) }),
  handler: async (_ctx, input, tx) => {
    const assetFilter =
      input.assetIds && input.assetIds.length > 0
        ? sql`AND mv.asset_id IN (SELECT jsonb_array_elements_text(${jsonbParam(input.assetIds)})::uuid)`
        : sql``;
    const scopeFilter =
      input.scope === "missing"
        ? sql`AND (mv.content_sha256 IS NULL OR mv.digest_profile IS DISTINCT FROM ${input.profile})`
        : sql``;
    const rows = (await tx.execute(sql`
      SELECT mv.asset_id::text AS asset_id, ma.slug, mv.variant, mv.storage_key,
             mv.content_sha256, mv.gzip_sha256, mv.gzip_size, mv.digest_profile
      FROM media_variants mv
      JOIN media_assets ma ON ma.id = mv.asset_id
      WHERE ma.deleted_at IS NULL ${scopeFilter} ${assetFilter}
      ORDER BY mv.asset_id, mv.variant
    `)) as unknown as {
      asset_id: string;
      slug: string;
      variant: string;
      storage_key: string;
      content_sha256: string | null;
      gzip_sha256: string | null;
      gzip_size: number | string | null;
      digest_profile: string | null;
    }[];
    return ok({
      targets: rows.map((r) => ({
        assetId: r.asset_id,
        slug: r.slug,
        variant: r.variant,
        storageKey: r.storage_key,
        stored:
          r.content_sha256 !== null && r.gzip_sha256 !== null && r.digest_profile !== null
            ? {
                contentSha256: r.content_sha256,
                gzipSha256: r.gzip_sha256,
                gzipSize: Number(r.gzip_size),
                profile: r.digest_profile,
              }
            : null,
      })),
    });
  },
});

const digestRow = z.object({
  assetId: z.string().uuid(),
  variant: z.string().min(1),
  storageKey: z.string().min(1),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  gzipSha256: z.string().regex(/^[0-9a-f]{64}$/),
  gzipSize: z.number().int().nonnegative(),
  profile: z.string().min(1).max(64),
});

/** Step 3 of media.rebuild_digests: store what was computed. */
export const storeDigestsOp = defineOperation({
  name: "media.store_digests",
  // Why system-only: a step of media.rebuild_digests (system-only, below).
  actorScope: ["system"],
  readScope: "request",
  database: "cms_admin",
  input: z.object({ digests: z.array(digestRow) }).strict(),
  output: z.object({ updated: z.number().int() }),
  handler: async (ctx, input, tx) => {
    let updated = 0;
    for (let at = 0; at < input.digests.length; at += WRITE_BATCH) {
      const batch = input.digests.slice(at, at + WRITE_BATCH).map((d) => ({
        asset_id: d.assetId,
        variant: d.variant,
        storage_key: d.storageKey,
        content_sha256: d.contentSha256,
        gzip_sha256: d.gzipSha256,
        gzip_size: d.gzipSize,
        digest_profile: d.profile,
      }));
      // Only where the row still names the file that was read: a variant
      // rewritten meanwhile stored its own digests with its write.
      const rows = (await tx.execute(sql`
        UPDATE media_variants mv
        SET content_sha256 = d.content_sha256,
            gzip_sha256 = d.gzip_sha256,
            gzip_size = d.gzip_size,
            digest_profile = d.digest_profile
        FROM jsonb_to_recordset(${jsonbParam(batch)}) AS d(
          asset_id uuid, variant text, storage_key text, content_sha256 text,
          gzip_sha256 text, gzip_size bigint, digest_profile text)
        WHERE mv.asset_id = d.asset_id AND mv.variant = d.variant
          AND mv.storage_key = d.storage_key
        RETURNING 1 AS updated
      `)) as unknown as { updated: number }[];
      updated += rows.length;
    }
    if (updated > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "media.rebuild_digests",
        input: { rows: input.digests.length },
        succeeded: true,
        resultSummary: `updated=${updated}`,
      });
    }
    return ok({ updated });
  },
});

const missingFile = z.object({
  assetId: z.string(),
  slug: z.string(),
  variant: z.string(),
  storageKey: z.string(),
});

/**
 * The backfill step of every build (deploy.trigger, Publish live's
 * rebuild): digest the media rows that have none. Returns null when every
 * row has digests now, else the reason it could not store them. Rows whose
 * file is gone are left to the generator, which names every such asset
 * with the way back (list_missing_media).
 */
export async function digestUndigestedMedia(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
): Promise<string | null> {
  const r = await execute(registry, adapter, ctx, "media.rebuild_digests", { scope: "missing" });
  return r.ok ? null : describeError(r.error);
}

/**
 * `media.rebuild_digests` — compute the stored digests of media files.
 * See the module comment.
 */
export const rebuildMediaDigestsOp = defineStepwiseOperation({
  name: "media.rebuild_digests",
  // Why system-only: derived state no one decides about. Every Stage and
  // Publish live rebuild runs the `missing` backfill before the generator
  // (as the system actor), so an AI or operator never has to ask for it;
  // a file changed outside Caelo is fixed by restoring the file, and the
  // `all` scope exists for that maintenance and for tests, not as a tool
  // (the tool catalogue shrinks, CLAUDE.md §11).
  actorScope: ["system"],
  // Why site-wide: a rebuild op over every media row (its purpose).
  readScope: "site",
  database: "cms_admin",
  input: scopeInput,
  output: z.object({
    /** Rows read. */
    checked: z.number().int(),
    /** Rows whose stored digests were missing or differed and are now right. */
    updated: z.number().int(),
    /** `scope: "all"`: rows whose stored digests were wrong (repaired). */
    corrected: z.array(z.object({ assetId: z.string(), slug: z.string(), variant: z.string() })),
    /** Rows whose file is not in storage — nothing to digest (see list_missing_media). */
    missingFiles: z.array(missingFile),
  }),
  stepwise: async (ctx, input, steps) => {
    const profile = await digestProfile();
    const listed = await execute(steps.registry, steps.adapter, ctx, "media.list_digest_targets", {
      ...input,
      profile,
    });
    if (!listed.ok) return err(listed.error);
    const { targets } = listed.value as { targets: TargetRow[] };
    if (targets.length === 0) {
      return ok({ checked: 0, updated: 0, corrected: [], missingFiles: [] });
    }
    const storage = getMediaStorage();
    const digests: z.infer<typeof digestRow>[] = [];
    const corrected: { assetId: string; slug: string; variant: string }[] = [];
    const missing: z.infer<typeof missingFile>[] = [];
    await runBatched(targets, DIGEST_PARALLELISM, async (t) => {
      let digest: PublishedDigest;
      try {
        const { body } = await storage.openStream(t.storageKey);
        digest = await digestStream(Readable.fromWeb(body as never));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          missing.push({
            assetId: t.assetId,
            slug: t.slug,
            variant: t.variant,
            storageKey: t.storageKey,
          });
          return;
        }
        throw e;
      }
      const same =
        t.stored !== null &&
        t.stored.contentSha256 === digest.contentSha256 &&
        t.stored.gzipSha256 === digest.gzipSha256 &&
        t.stored.gzipSize === digest.gzipSize &&
        t.stored.profile === digest.profile;
      if (same) return;
      if (t.stored !== null && t.stored.profile === digest.profile) {
        corrected.push({ assetId: t.assetId, slug: t.slug, variant: t.variant });
      }
      digests.push({
        assetId: t.assetId,
        variant: t.variant,
        storageKey: t.storageKey,
        contentSha256: digest.contentSha256,
        gzipSha256: digest.gzipSha256,
        gzipSize: digest.gzipSize,
        profile: digest.profile,
      });
    });
    let updated = 0;
    if (digests.length > 0) {
      const stored = await execute(steps.registry, steps.adapter, ctx, "media.store_digests", {
        digests,
      });
      if (!stored.ok) {
        return err({
          kind: "HandlerError",
          operation: "media.rebuild_digests",
          message: `the digests of ${digests.length} media file(s) were computed but could not be stored: ${describeError(stored.error)}`,
        });
      }
      updated = (stored.value as { updated: number }).updated;
    }
    return ok({ checked: targets.length, updated, corrected, missingFiles: missing });
  },
});
