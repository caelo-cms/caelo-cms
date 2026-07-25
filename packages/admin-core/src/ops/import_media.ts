// SPDX-License-Identifier: MPL-2.0

/**
 * `imports.import_media_urls` — EXPLICIT, URL-driven media import.
 *
 * The AI names the exact source-site asset URLs it wants in the media
 * library (typically from `inspect_external_page`'s image inventory) and
 * this op downloads each through the site-importer SSRF guard, re-encodes
 * it through the standard media pipeline, and stores it — returning the
 * Caelo media URL the AI references in `build_page`.
 *
 * This replaces the former scan-and-download `imports.migrate_media`,
 * which pulled media by discovering references in already-built pages.
 * That model coupled media import to a compose/build linkage that broke
 * across build flows (issues #278, #302) and read a "0 assets" result as
 * a silent success. Explicit URLs make the blast radius visible: the AI
 * decides what to import, and every URL that could not be imported comes
 * back in `skipped` with a reason (CLAUDE.md §2 — nothing silently
 * dropped).
 *
 * Network I/O inside a Query-API handler is deliberate here (the
 * neighbouring media ops keep the chokepoint DB-only): the download's
 * bytes and its media_assets metadata row must land in the same tx. The
 * per-file + per-call caps below bound how long the tx can stay open.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  err,
  MEDIA_HARD_LIMIT_BYTES,
  MEDIA_SIZE_CAPS,
  type MediaMime,
  type MediaStorageAdapter,
  ok,
} from "@caelo-cms/shared";
import { isExternalUrlBlockedError, safeExternalFetchBinary } from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  discoverAssetRefs,
  magicBytesMatchMime,
  normalizeAssetMime,
} from "../media/import-asset-urls.js";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage, getMediaStorageProvider } from "../media/storage.js";
import { mediaUploadOp } from "./media.js";

// Fetch ceiling = the shared media hard limit (50 MB). Per-mime caps
// (MEDIA_SIZE_CAPS) narrow this further downstream so a 40 MB image
// can't slip through the raised video-sized fetch cap.
const PER_FILE_MAX_BYTES = MEDIA_HARD_LIMIT_BYTES;
const PER_CALL_MAX_BYTES = 250 * 1024 * 1024;
const PER_FILE_TIMEOUT_MS = 20_000;
const PER_CALL_TIME_BUDGET_MS = 5 * 60_000;

/**
 * Same env-var exemption list the crawler/orchestrator honour
 * (`CAELO_IMPORTER_ALLOWED_HOSTS`) — exact hostnames the SSRF guard
 * lets through for test fixture servers and deliberate private-network
 * migrations. Read per call so tests can toggle it.
 */
function allowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  // crypto.subtle.digest needs an ArrayBuffer; slice to avoid the
  // SharedArrayBuffer-vs-ArrayBuffer typing wrinkle.
  const view = new Uint8Array(body);
  const hash = await crypto.subtle.digest("SHA-256", view.buffer.slice(0));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Filename for the media row, recovered from the source URL path. */
function originalNameFromUrl(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return (base || "imported-asset").slice(0, 512);
  } catch {
    return "imported-asset";
  }
}

const importedEntry = z.object({
  sourceUrl: z.string(),
  mediaId: z.string(),
  /** The asset's meaningful, URL-safe slug (public URL segment). */
  slug: z.string(),
  /** The Caelo media path to reference in <img src> (e.g. /_caelo/media/<slug>). */
  mediaUrl: z.string(),
});
const skippedEntry = z.object({ url: z.string(), reason: z.string() });

/** One asset to import: its source URL + an optional meaningful label. */
const importAssetInput = z.object({
  /** The exact absolute source-site asset URL to download. */
  url: z.string().url(),
  /**
   * Short, meaningful, human label for the asset (e.g. "SearchVIU logo",
   * "hero background"). Becomes the public media slug (`/_caelo/media/<slug>`);
   * the UUID id stays internal. Optional — falls back to the URL filename.
   */
  name: z.string().max(200).optional(),
});

export const importMediaUrlsOp = defineOperation({
  name: "imports.import_media_urls",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /**
       * The exact source-site assets to import (max 50 per call), each with
       * an optional meaningful `name` that becomes the asset's public slug.
       */
      assets: z.array(importAssetInput).min(1).max(50),
      /**
       * Optional migration-run id, recorded for provenance/audit. The
       * import itself does not depend on a run — explicit URLs stand on
       * their own — so it is nullable/optional.
       */
      runId: z.string().uuid().nullable().optional(),
    })
    .strict(),
  output: z.object({
    /** Assets that now live in the media library, with the URL to reference. */
    imported: z.array(importedEntry),
    /** Every URL that could NOT be imported, each with a reason. */
    skipped: z.array(skippedEntry),
  }),
  handler: async (ctx, input, tx) => {
    // Fail loudly BEFORE any network work when the storage adapter is
    // not wired (no-fallbacks pre-1.0).
    let storage: MediaStorageAdapter | null = null;
    let storageError = "media storage not initialised";
    try {
      storage = getMediaStorage();
    } catch (e) {
      storageError = (e as Error).message;
    }
    if (storage === null) {
      return err({
        kind: "HandlerError",
        operation: "imports.import_media_urls",
        message: storageError,
      });
    }
    // Narrowed non-null view for the persist closure below.
    const mediaStorage = storage;

    // De-dupe the asset list up front — the same URL twice is one download.
    // The first occurrence's name wins.
    const uniqueAssets: Array<{ url: string; name?: string }> = [];
    const seenUrls = new Set<string>();
    for (const asset of input.assets) {
      if (!seenUrls.has(asset.url)) {
        seenUrls.add(asset.url);
        uniqueAssets.push(asset);
      }
    }

    const imported: Array<z.infer<typeof importedEntry>> = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    let downloadedBytes = 0;
    const deadline = Date.now() + PER_CALL_TIME_BUDGET_MS;
    const hosts = allowedHosts();

    type PersistResult =
      | { ok: true; assetId: string; slug: string }
      | { ok: false; reason: string };
    const persistAsset = async (
      url: string,
      name: string | undefined,
      mime: MediaMime,
      sha: string,
      bytes: Uint8Array,
    ): Promise<PersistResult> => {
      let pipeline: Awaited<ReturnType<typeof runMediaPipeline>>;
      try {
        // The pipeline re-encodes rasters (validating them) and strips
        // scripts from SVG — the same hardening the upload endpoint gets.
        pipeline = await runMediaPipeline(sha, mime, bytes);
      } catch (e) {
        return { ok: false, reason: `processing-failed: ${(e as Error).message.slice(0, 200)}` };
      }
      for (const v of pipeline.variants) {
        await mediaStorage.put(v.storageKey, v.body, v.contentType);
      }
      // Direct handler call (same pattern the neighbouring media ops use):
      // this op is the audited boundary; the upload handler adds its own
      // audit row + sha dedup.
      const upload = await mediaUploadOp.handler(
        ctx,
        {
          sha256: sha,
          originalName: originalNameFromUrl(url),
          // Meaningful public slug: the AI-supplied label wins; the handler
          // falls back to alt → originalName when it's absent.
          name,
          mime,
          sizeBytes: bytes.byteLength,
          width: pipeline.width,
          height: pipeline.height,
          alt: "",
          storageKey: pipeline.variants[0]?.storageKey ?? `${sha}/orig`,
          storageProvider: getMediaStorageProvider(),
          // Media provenance (0181) — the asset was downloaded from the
          // source site being migrated; record its origin URL.
          sourceKind: "imported",
          sourceDetail: url,
          variants: pipeline.variants.map((v) => ({
            variant: v.variant,
            format: v.format,
            width: v.width,
            height: v.height,
            sizeBytes: v.sizeBytes,
            storageKey: v.storageKey,
          })),
        },
        tx,
      );
      if (!upload.ok) {
        return {
          ok: false,
          reason: `media-upload-failed: ${JSON.stringify(upload.error).slice(0, 200)}`,
        };
      }
      const uploaded = upload.value as { assetId: string; slug: string };
      return { ok: true, assetId: uploaded.assetId, slug: uploaded.slug };
    };

    for (const { url, name } of uniqueAssets) {
      if (downloadedBytes >= PER_CALL_MAX_BYTES) {
        skipped.push({ url, reason: "call-budget-exhausted (250 MB download cap)" });
        continue;
      }
      if (Date.now() >= deadline) {
        skipped.push({ url, reason: "time-budget-exhausted (5 min per call)" });
        continue;
      }

      let res: Awaited<ReturnType<typeof safeExternalFetchBinary>>;
      try {
        res = await safeExternalFetchBinary(url, {
          allowedHosts: hosts,
          maxBytes: PER_FILE_MAX_BYTES,
          timeoutMs: PER_FILE_TIMEOUT_MS,
          headers: { Accept: "image/*,video/mp4,font/*,application/pdf,*/*;q=0.5" },
        });
      } catch (e) {
        if (isExternalUrlBlockedError(e)) {
          skipped.push({ url, reason: `blocked-by-ssrf-guard: ${e.reason}` });
        } else if (e instanceof Error && e.message.includes("-byte cap")) {
          skipped.push({ url, reason: "too-large (50 MB per-file cap)" });
        } else {
          skipped.push({ url, reason: `fetch-failed: ${(e as Error).message.slice(0, 200)}` });
        }
        continue;
      }
      if (!res.ok) {
        skipped.push({ url, reason: `http-${res.status}` });
        continue;
      }
      const mime = normalizeAssetMime(res.contentType);
      if (mime === null) {
        skipped.push({ url, reason: `blocked-content-type (${res.contentType || "none"})` });
        continue;
      }
      if (!magicBytesMatchMime(mime, res.bodyBytes)) {
        skipped.push({ url, reason: `content-mismatch (served bytes do not look like ${mime})` });
        continue;
      }
      // Per-mime cap: the fetch ceiling is the 50 MB video-sized hard
      // limit, so a 40 MB image (image cap 10 MB) would otherwise slip
      // through. Enforce the tighter per-mime cap here, loudly.
      const mimeCap = MEDIA_SIZE_CAPS[mime];
      if (res.bodyBytes.length > mimeCap) {
        skipped.push({
          url,
          reason: `too-large (${res.bodyBytes.length} bytes exceeds the ${mime} cap of ${mimeCap} bytes)`,
        });
        continue;
      }

      const sha = await sha256Hex(res.bodyBytes);
      // Dedupe by content hash against the whole library. media.upload
      // dedupes too, but the pre-check skips a redundant pipeline run for
      // bytes that already exist.
      const existing = (await tx.execute(sql`
        SELECT id::text AS id, slug FROM media_assets
        WHERE sha256 = ${sha} AND deleted_at IS NULL LIMIT 1
      `)) as unknown as Array<{ id: string; slug: string }>;
      if (existing[0]) {
        imported.push({
          sourceUrl: url,
          mediaId: existing[0].id,
          slug: existing[0].slug,
          mediaUrl: buildMediaUrl(existing[0].slug, "orig"),
        });
        continue;
      }

      const persisted = await persistAsset(url, name, mime, sha, res.bodyBytes);
      if (!persisted.ok) {
        skipped.push({ url, reason: persisted.reason });
        continue;
      }
      downloadedBytes += res.bodyBytes.byteLength;
      imported.push({
        sourceUrl: url,
        mediaId: persisted.assetId,
        slug: persisted.slug,
        mediaUrl: buildMediaUrl(persisted.slug, "orig"),
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.import_media_urls",
      input: { urls: uniqueAssets.length, runId: input.runId ?? null },
      succeeded: true,
      entityId: input.runId ?? null,
      resultSummary: `imported=${imported.length} skipped=${skipped.length} bytes=${downloadedBytes}`,
    });

    return ok({ imported, skipped });
  },
});

const pageAssetEntry = z.object({
  /** Absolute source URL of the asset. */
  url: z.string(),
  /** Total occurrences across the scanned pages (prominence signal). */
  count: z.number().int(),
  /** Distinct crawled pages the asset appears on. */
  pages: z.number().int(),
  /** First source `alt` seen for the asset, or null. */
  alt: z.string().nullable(),
});

/**
 * `imports.list_page_assets` — the COMPLETE, searchable asset inventory of
 * a crawled import run. `inspect_external_page`'s `images` facet shows only
 * the top ~20 for a quick glance; this op runs the SAME comprehensive
 * `discoverAssetRefs` (img src+srcset, CSS `url(...)`, video/audio/source)
 * over the run's STORED page HTML (`import_pages.proposed_modules`) and
 * returns every distinct asset URL — optionally narrowed to one page and/or
 * a substring `search`, ranked by prominence, paginated. The AI feeds the
 * URLs it wants to `import_media_from_urls`.
 */
export const listPageAssetsOp = defineOperation({
  name: "imports.list_page_assets",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      /** Restrict to one crawled page by its source URL (exact match). */
      pageUrl: z.string().url().optional(),
      /** Case-insensitive substring the asset URL must contain. */
      search: z.string().min(1).max(400).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  output: z.object({
    /** Distinct assets matching the filter, before pagination. */
    total: z.number().int(),
    /** Assets returned in this page of results. */
    assets: z.array(pageAssetEntry),
    /** Crawled pages scanned to build the inventory. */
    pagesScanned: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    const runRows = (await tx.execute(sql`
      SELECT id::text AS id FROM import_runs WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!runRows[0]) {
      return err({
        kind: "HandlerError",
        operation: "imports.list_page_assets",
        message: "import run not found — list runs with imports.list for valid ids",
      });
    }

    const pageFilter = input.pageUrl ? sql` AND source_url = ${input.pageUrl}` : sql.raw("");
    const pageRows = (await tx.execute(sql`
      SELECT source_url, proposed_modules
      FROM import_pages
      WHERE run_id = ${input.runId}::uuid ${pageFilter}
      ORDER BY created_at ASC
    `)) as unknown as Array<{
      source_url: string;
      proposed_modules: Array<{ html?: string }> | null;
    }>;

    // Aggregate across pages: occurrence count + distinct-page count +
    // first alt + first DOM position (tie-breaker), keyed by absolute URL.
    const byUrl = new Map<
      string,
      { url: string; count: number; pages: Set<string>; alt: string | null; firstPos: number }
    >();
    for (const page of pageRows) {
      const html = (page.proposed_modules ?? []).map((m) => m.html ?? "").join("\n");
      if (html === "") continue;
      for (const ref of discoverAssetRefs(html, "html", page.source_url).refs) {
        const existing = byUrl.get(ref.url);
        if (existing) {
          existing.count += 1;
          existing.pages.add(page.source_url);
          if (existing.alt === null && ref.alt) existing.alt = ref.alt;
        } else {
          byUrl.set(ref.url, {
            url: ref.url,
            count: 1,
            pages: new Set([page.source_url]),
            alt: ref.alt ?? null,
            firstPos: ref.start,
          });
        }
      }
    }

    const needle = input.search?.toLowerCase();
    const ranked = [...byUrl.values()]
      .filter((a) => (needle ? a.url.toLowerCase().includes(needle) : true))
      .sort((a, b) => b.count - a.count || a.firstPos - b.firstPos);

    const offset = input.offset ?? 0;
    const limit = input.limit ?? 200;
    const paged = ranked.slice(offset, offset + limit);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.list_page_assets",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `total=${ranked.length} returned=${paged.length} pages=${pageRows.length}`,
    });

    return ok({
      total: ranked.length,
      assets: paged.map((a) => ({ url: a.url, count: a.count, pages: a.pages.size, alt: a.alt })),
      pagesScanned: pageRows.length,
    });
  },
});
