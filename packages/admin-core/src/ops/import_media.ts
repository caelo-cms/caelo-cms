// SPDX-License-Identifier: MPL-2.0

/**
 * issue #249 (WS3) — `imports.migrate_media`. A migration is not done
 * while the source host still serves the assets: kill the old server
 * and the "migrated" site loses every image. This op runs AFTER
 * `imports.compose_from_run` and, in one boundary:
 *
 *   1. reads the run's composed module bodies (page modules via
 *      import_pages.accepted_page_id, plus the layout-bound chrome
 *      modules `imported-<runid8>-header/footer`) and the cluster
 *      templates' replayed CSS,
 *   2. discovers every external asset reference (img src/srcset,
 *      source/video/audio src+poster, CSS url(...) incl. inline
 *      styles),
 *   3. downloads them through the site-importer SSRF guard with hard
 *      caps (15 MB/file, 250 MB/run, 400 assets/run, 5 min wall
 *      clock), content-type allowlist (images/fonts/pdf/svg — SVG is
 *      script-sanitised by the media pipeline),
 *   4. stores them via the standard media pipeline + storage adapter,
 *      deduped by content sha256 against the whole library,
 *   5. rewrites the module HTML/CSS + template CSS in place,
 *   6. returns a loud report — every unmigrated reference appears in
 *      `skipped` with a reason (CLAUDE.md §2: nothing silently
 *      dropped). Idempotent: refs already pointing at `/_caelo/...`
 *      are counted as `alreadyLocal` and left alone.
 *
 * Network I/O inside a Query-API handler is deliberate here (the
 * neighbouring media ops keep the chokepoint DB-only): the rewrite
 * must be atomic with the downloads' metadata rows, and the op is the
 * only boundary that sees both. The caps above bound how long the tx
 * can stay open.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  err,
  type MediaMime,
  type MediaStorageAdapter,
  ok,
} from "@caelo-cms/shared";
import { isExternalUrlBlockedError, safeExternalFetchBinary } from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  type DiscoveredAssetRef,
  discoverAssetRefs,
  magicBytesMatchMime,
  normalizeAssetMime,
  rewriteAssetRefs,
} from "../media/import-asset-urls.js";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage, getMediaStorageProvider } from "../media/storage.js";
import { mediaRecordUsageOp, mediaUploadOp } from "./media.js";

const PER_FILE_MAX_BYTES = 15 * 1024 * 1024;
const PER_RUN_MAX_BYTES = 250 * 1024 * 1024;
const PER_RUN_MAX_ASSETS = 400;
const PER_FILE_TIMEOUT_MS = 20_000;
const PER_RUN_TIME_BUDGET_MS = 5 * 60_000;

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

const skippedEntry = z.object({ url: z.string(), reason: z.string() });

/** One rewritable text (module html/css or template css) + its base URL. */
interface TextUnit {
  kind: "module" | "template";
  id: string;
  /** Empty string for templates (css-only units). */
  html: string;
  css: string;
  /** The page's original source URL — relative refs resolve against it. */
  baseUrl: string;
}

export const migrateImportMediaOp = defineOperation({
  name: "imports.migrate_media",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({
    /** Assets downloaded + inserted into the media library. */
    migrated: z.number().int(),
    migratedBytes: z.number().int(),
    /** URLs whose bytes already existed in the library (sha256 dedup). */
    dedupedExisting: z.number().int(),
    /** Refs already pointing at Caelo media — idempotent re-runs. */
    alreadyLocal: z.number().int(),
    modulesRewritten: z.number().int(),
    templatesRewritten: z.number().int(),
    /** Every reference that could NOT be migrated, with the reason. */
    skipped: z.array(skippedEntry),
  }),
  handler: async (ctx, input, tx) => {
    const runRows = (await tx.execute(sql`
      SELECT id::text AS id, source_url FROM import_runs
      WHERE id = ${input.runId}::uuid LIMIT 1
    `)) as unknown as Array<{ id: string; source_url: string }>;
    const run = runRows[0];
    if (!run) {
      return err({
        kind: "HandlerError",
        operation: "imports.migrate_media",
        message: "import run not found — list runs with imports.list for valid ids",
      });
    }

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
        operation: "imports.migrate_media",
        message: storageError,
      });
    }
    // Narrowed non-null view for the persist closure below.
    const mediaStorage = storage;

    // ------------------------------------------------------------------
    // 1. Collect the run's rewritable texts.
    // ------------------------------------------------------------------
    const moduleRows = (await tx.execute(sql`
      SELECT DISTINCT m.id::text AS id, m.html, m.css, ip.source_url
      FROM modules m
      JOIN page_modules pm ON pm.module_id = m.id
      JOIN import_pages ip ON ip.accepted_page_id = pm.page_id
      WHERE ip.run_id = ${input.runId}::uuid AND m.deleted_at IS NULL
    `)) as unknown as Array<{ id: string; html: string; css: string; source_url: string }>;

    // Chrome binds at the layout (issue #253), so it never appears in
    // page_modules — address it by its deterministic slug.
    const chromeRows = (await tx.execute(sql`
      SELECT id::text AS id, html, css FROM modules
      WHERE slug IN (${`imported-${input.runId.slice(0, 8)}-header`},
                     ${`imported-${input.runId.slice(0, 8)}-footer`})
        AND deleted_at IS NULL
    `)) as unknown as Array<{ id: string; html: string; css: string }>;

    const templateRows = (await tx.execute(sql`
      SELECT DISTINCT t.id::text AS id, t.css
      FROM templates t
      JOIN pages p ON p.template_id = t.id
      JOIN import_pages ip ON ip.accepted_page_id = p.id
      WHERE ip.run_id = ${input.runId}::uuid AND t.deleted_at IS NULL AND t.css <> ''
    `)) as unknown as Array<{ id: string; css: string }>;

    // Dedupe modules by id — a module placed on several of the run's
    // pages (or a chrome module that also shows up via page_modules on
    // a legacy pre-#253 compose) must be rewritten and usage-counted
    // exactly once. First occurrence wins; page rows come first so the
    // page's own source_url stays the resolution base.
    const moduleUnitsById = new Map<string, TextUnit>();
    for (const m of moduleRows) {
      if (!moduleUnitsById.has(m.id)) {
        moduleUnitsById.set(m.id, {
          kind: "module",
          id: m.id,
          html: m.html,
          css: m.css,
          baseUrl: m.source_url,
        });
      }
    }
    for (const m of chromeRows) {
      if (!moduleUnitsById.has(m.id)) {
        moduleUnitsById.set(m.id, {
          kind: "module",
          id: m.id,
          html: m.html,
          css: m.css,
          baseUrl: run.source_url,
        });
      }
    }
    const units: TextUnit[] = [
      ...moduleUnitsById.values(),
      ...templateRows.map((t) => ({
        kind: "template" as const,
        id: t.id,
        html: "",
        css: t.css,
        baseUrl: run.source_url,
      })),
    ];
    if (units.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "imports.migrate_media",
        message:
          "no composed modules found for this run — run compose_from_import first, then migrate media",
      });
    }

    // ------------------------------------------------------------------
    // 2. Discover external refs. One download per unique absolute URL.
    // ------------------------------------------------------------------
    const skipped: Array<{ url: string; reason: string }> = [];
    let alreadyLocal = 0;
    const perUnitRefs = new Map<
      TextUnit,
      { html: DiscoveredAssetRef[]; css: DiscoveredAssetRef[] }
    >();
    /** url → first non-empty source alt attribute. */
    const altByUrl = new Map<string, string>();
    const uniqueUrls: string[] = [];
    const seenUrls = new Set<string>();

    for (const unit of units) {
      const htmlDisc =
        unit.html === ""
          ? { refs: [], alreadyLocal: 0, unparseable: [] }
          : discoverAssetRefs(unit.html, "html", unit.baseUrl);
      const cssDisc =
        unit.css === ""
          ? { refs: [], alreadyLocal: 0, unparseable: [] }
          : discoverAssetRefs(unit.css, "css", unit.baseUrl);
      perUnitRefs.set(unit, { html: htmlDisc.refs, css: cssDisc.refs });
      alreadyLocal += htmlDisc.alreadyLocal + cssDisc.alreadyLocal;
      for (const raw of [...htmlDisc.unparseable, ...cssDisc.unparseable]) {
        skipped.push({ url: raw.slice(0, 500), reason: "unparseable-url" });
      }
      for (const ref of [...htmlDisc.refs, ...cssDisc.refs]) {
        if (!seenUrls.has(ref.url)) {
          seenUrls.add(ref.url);
          uniqueUrls.push(ref.url);
        }
        if (ref.alt && !altByUrl.has(ref.url)) altByUrl.set(ref.url, ref.alt);
      }
    }

    // ------------------------------------------------------------------
    // 3. Download + persist. urlMap holds the successful rewrites.
    // ------------------------------------------------------------------
    const urlMap = new Map<string, string>();
    const assetIdByUrl = new Map<string, string>();
    let migrated = 0;
    let migratedBytes = 0;
    let dedupedExisting = 0;
    const deadline = Date.now() + PER_RUN_TIME_BUDGET_MS;
    const hosts = allowedHosts();

    type PersistResult = { ok: true; assetId: string } | { ok: false; reason: string };
    const persistAsset = async (
      url: string,
      mime: MediaMime,
      sha: string,
      bytes: Uint8Array,
      alt: string | undefined,
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
      // Direct handler call (same pattern as compose_from_run →
      // themes.update_tokens): this op is the audited boundary; the
      // upload handler adds its own audit row + sha dedup.
      const upload = await mediaUploadOp.handler(
        ctx,
        {
          sha256: sha,
          originalName: originalNameFromUrl(url),
          mime,
          sizeBytes: bytes.byteLength,
          width: pipeline.width,
          height: pipeline.height,
          alt: (alt ?? "").slice(0, 2048),
          storageKey: pipeline.variants[0]?.storageKey ?? `${sha}/orig`,
          storageProvider: getMediaStorageProvider(),
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
      return { ok: true, assetId: (upload.value as { assetId: string }).assetId };
    };

    for (const url of uniqueUrls) {
      if (migrated + dedupedExisting + skipped.length >= PER_RUN_MAX_ASSETS) {
        skipped.push({ url, reason: `asset-count-cap (${PER_RUN_MAX_ASSETS} per run)` });
        continue;
      }
      if (migratedBytes >= PER_RUN_MAX_BYTES) {
        skipped.push({ url, reason: "run-budget-exhausted (250 MB download cap)" });
        continue;
      }
      if (Date.now() >= deadline) {
        skipped.push({ url, reason: "time-budget-exhausted (5 min per run)" });
        continue;
      }

      let res: Awaited<ReturnType<typeof safeExternalFetchBinary>>;
      try {
        res = await safeExternalFetchBinary(url, {
          allowedHosts: hosts,
          maxBytes: PER_FILE_MAX_BYTES,
          timeoutMs: PER_FILE_TIMEOUT_MS,
          headers: { Accept: "image/*,font/*,application/pdf,*/*;q=0.5" },
        });
      } catch (e) {
        if (isExternalUrlBlockedError(e)) {
          skipped.push({ url, reason: `blocked-by-ssrf-guard: ${e.reason}` });
        } else if (e instanceof Error && e.message.includes("-byte cap")) {
          skipped.push({ url, reason: "too-large (15 MB per-file cap)" });
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

      const sha = await sha256Hex(res.bodyBytes);
      const existing = (await tx.execute(sql`
        SELECT id::text AS id FROM media_assets
        WHERE sha256 = ${sha} AND deleted_at IS NULL LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      if (existing[0]) {
        dedupedExisting += 1;
        urlMap.set(url, buildMediaUrl(existing[0].id, "orig"));
        assetIdByUrl.set(url, existing[0].id);
        continue;
      }

      const persisted = await persistAsset(url, mime, sha, res.bodyBytes, altByUrl.get(url));
      if (!persisted.ok) {
        skipped.push({ url, reason: persisted.reason });
        continue;
      }
      migrated += 1;
      migratedBytes += res.bodyBytes.byteLength;
      urlMap.set(url, buildMediaUrl(persisted.assetId, "orig"));
      assetIdByUrl.set(url, persisted.assetId);
    }

    // ------------------------------------------------------------------
    // 4. Rewrite texts in place + track per-module usage deltas.
    // ------------------------------------------------------------------
    let modulesRewritten = 0;
    let templatesRewritten = 0;
    const usageDeltas: Record<string, number> = {};
    for (const unit of units) {
      const refs = perUnitRefs.get(unit);
      if (!refs) continue;
      const newHtml = unit.html === "" ? "" : rewriteAssetRefs(unit.html, refs.html, urlMap);
      const newCss = unit.css === "" ? "" : rewriteAssetRefs(unit.css, refs.css, urlMap);
      if (newHtml === unit.html && newCss === unit.css) continue;
      if (unit.kind === "module") {
        await tx.execute(sql`
          UPDATE modules SET html = ${newHtml}, css = ${newCss}
          WHERE id = ${unit.id}::uuid
        `);
        modulesRewritten += 1;
        // Usage counting is per (asset, module) — mirrors the post-write
        // usage tracker so media.delete's referenced-guard stays honest.
        const assetsInUnit = new Set<string>();
        for (const ref of [...refs.html, ...refs.css]) {
          const assetId = assetIdByUrl.get(ref.url);
          if (assetId) assetsInUnit.add(assetId);
        }
        for (const assetId of assetsInUnit) {
          usageDeltas[assetId] = (usageDeltas[assetId] ?? 0) + 1;
        }
      } else {
        await tx.execute(sql`
          UPDATE templates SET css = ${newCss} WHERE id = ${unit.id}::uuid
        `);
        templatesRewritten += 1;
      }
    }
    if (Object.keys(usageDeltas).length > 0) {
      // System-only op invoked through its handler — this op is the
      // boundary; the delta write is an internal bookkeeping step.
      await mediaRecordUsageOp.handler(ctx, { deltas: usageDeltas }, tx);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "imports.migrate_media",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: `migrated=${migrated} bytes=${migratedBytes} deduped=${dedupedExisting} local=${alreadyLocal} modules=${modulesRewritten} templates=${templatesRewritten} skipped=${skipped.length}`,
    });

    return ok({
      migrated,
      migratedBytes,
      dedupedExisting,
      alreadyLocal,
      modulesRewritten,
      templatesRewritten,
      skipped,
    });
  },
});
