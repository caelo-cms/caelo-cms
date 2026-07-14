// SPDX-License-Identifier: MPL-2.0

/**
 * issue #249 (WS3) — `imports.migrate_media`. A migration is not done
 * while the source host still serves the assets: kill the old server
 * and the "migrated" site loses every image. This op runs AFTER the
 * pages exist (either `imports.compose_from_run` OR the #278 homepage-first
 * direct-build flow) and, in one boundary:
 *
 *   1. reads the run's composed module bodies (page modules via
 *      import_pages.accepted_page_id, plus the layout-bound chrome
 *      modules `imported-<runid8>-header/footer`) and the cluster
 *      templates' replayed CSS. When that compose linkage is empty —
 *      the #278 direct-build flow creates pages via `pages.create`
 *      without an `import_pages.accepted_page_id` and names its chrome
 *      differently — it FALLS BACK to the migration-built site:
 *      every placed page module, the layout-bound chrome (where
 *      the header logo lives), and non-empty template CSS. The fallback
 *      is BRANCH-AWARE (issue #302): chat-built pages keep their
 *      placements in branched page_layout_snapshots (never in live
 *      page_modules) and their module text in branched module_snapshots,
 *      so collection goes through the branch overlay — and rewrites emit
 *      a branched snapshot so chat.publish ships the rewritten text,
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

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  buildMediaUrl,
  err,
  type MediaMime,
  type MediaStorageAdapter,
  ok,
} from "@caelo-cms/shared";
import {
  isExternalUrlBlockedError,
  type ProposedModuleBlock,
  rebuiltHeaderHasLogoRef,
  safeExternalFetchBinary,
  sourceHeaderHasLogoImage,
} from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  assembleDirectBuildUnits,
  loadModuleTextWithBranchProvenance,
  loadTemplateWithBranchProvenance,
  type ModuleTextWithProvenance,
  resolveDirectBuildModuleRows,
  type TemplateCssRow,
  type TextUnit,
} from "../media/direct-build-units.js";
import {
  type DiscoveredAssetRef,
  discoverAssetRefs,
  magicBytesMatchMime,
  normalizeAssetMime,
  rewriteAssetRefs,
} from "../media/import-asset-urls.js";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage, getMediaStorageProvider } from "../media/storage.js";
import type { SnapshotEntity } from "../snapshots/index.js";
import { emitSnapshot, loadPageLayoutStateWithBranchOverlay } from "../snapshots/index.js";
import { jsonbParam } from "../sql-helpers.js";
import { mediaRecordUsageOp, mediaUploadOp } from "./media.js";

// Re-exported so existing consumers (tests, tools) keep their import path.
export {
  assembleDirectBuildUnits,
  type ModuleTextRow,
  resolveDirectBuildModuleRows,
  type TemplateCssRow,
  type TextUnit,
} from "../media/direct-build-units.js";

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

/**
 * issue #302 — LOUD telemetry: per-source unit counts, reported in the op
 * output, in an `import_run_events` info row, AND on the server console
 * (the console line survives a DB reset, which is exactly what erased the
 * run-15 evidence).
 */
const unitsBySourceShape = z.object({
  /** Compose linkage: page modules via import_pages.accepted_page_id. */
  composePageModules: z.number().int(),
  /** Compose linkage: `imported-<runid8>-header/footer` chrome modules. */
  composeChrome: z.number().int(),
  /** Compose linkage: template CSS via import_pages join. */
  composeTemplates: z.number().int(),
  /** Direct-build fallback: modules placed on built pages (branch-aware). */
  directPageModules: z.number().int(),
  /** Direct-build fallback: layout-bound chrome via layout_modules. */
  directChrome: z.number().int(),
  /** Direct-build fallback: non-empty template CSS on built pages. */
  directTemplates: z.number().int(),
});
export type UnitsBySource = z.infer<typeof unitsBySourceShape>;

/**
 * Append a media-phase event to the run ledger inside the op's own tx —
 * same direct-INSERT shape as `detectRedrawnLogo` below (going through
 * `imports.log_event`'s handler would add a second audit row per event).
 */
async function logMediaRunEvent(
  tx: TransactionRunner,
  runId: string,
  severity: "info" | "warning",
  message: string,
  detail: unknown,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO import_run_events (run_id, severity, phase, message, detail)
    VALUES (${runId}::uuid, ${severity}, 'media', ${message}, ${jsonbParam(detail)})
  `);
}

export const migrateImportMediaOp = defineOperation({
  name: "imports.migrate_media",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      /**
       * Optional scope for the DIRECT-BUILD fallback (issue #278): restrict
       * the page-module + template-CSS collection to these built page ids.
       * Omitted → site-wide (the safe default, since a migration runs on a
       * fresh site where every page is the migration's). Ignored on the
       * compose path, which keys off the run's `import_pages` linkage.
       */
      pageIds: z.array(z.string().uuid()).optional(),
    })
    .strict(),
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
    /**
     * issue #302 — where the rewritable units came from, per source. The
     * AI tool surfaces these counts so a "0 assets migrated" result is
     * diagnosable in the same turn instead of reading as a silent ok.
     */
    unitsBySource: unitsBySourceShape,
    /**
     * Set when ZERO rewritable units were found (with likely causes).
     * The run continues to a zero-count success — the warning is the loud
     * part; a HandlerError here would cost a full error→analyze→retry
     * round-trip (#307 W4) without being more actionable.
     */
    unitsWarning: z.string().nullable(),
    /**
     * Logo-preservation guardrail: set when the source homepage header
     * carried a real logo image but the rebuilt chrome header references
     * none (no Caelo-media <img>, no {{theme_logo_url}}, no bound theme
     * logo asset) — i.e. the logo was hand-authored as a text/CSS
     * wordmark instead of imported. The message is also appended to the
     * run's error/warning ledger so the closing report surfaces it.
     * `null` when the logo was preserved, or the source had no logo image.
     */
    logoWarning: z.string().nullable(),
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
    let units: TextUnit[] = [
      ...moduleUnitsById.values(),
      ...templateRows.map((t) => ({
        kind: "template" as const,
        id: t.id,
        html: "",
        css: t.css,
        baseUrl: run.source_url,
      })),
    ];

    const branchId = ctx.chatBranchId ?? null;
    const unitsBySource: UnitsBySource = {
      composePageModules: moduleRows.length,
      composeChrome: chromeRows.length,
      composeTemplates: templateRows.length,
      directPageModules: 0,
      directChrome: 0,
      directTemplates: 0,
    };

    // Direct-build fallback (issue #278). The homepage-first flow builds
    // pages straight through `pages.create` and binds chrome via
    // `layout_modules`, so NONE of the three compose-keyed queries above
    // match (no `import_pages.accepted_page_id`, chrome named differently).
    //
    // issue #302 — the fallback is BRANCH-AWARE. A chat-run migration
    // creates its pages on the chat's preview branch, and branched
    // `pages.set_modules` NEVER writes live `page_modules` rows — the
    // placements exist only as branched `page_layout_snapshots`. The
    // pre-#302 fallback joined live `page_modules` directly and therefore
    // found ZERO page-module units for every chat-built page (run #15:
    // media_assets n_tup_ins=0 across the whole run). Placements are now
    // resolved through the branch overlay, module/template text through
    // the branch-latest snapshot state.
    //
    // A migration runs on a fresh site, so site-wide is safe;
    // `input.pageIds` narrows it when a caller wants to.
    if (units.length === 0) {
      // Zod validated each id as a UUID, so the raw ARRAY literal is
      // injection-safe (same pattern as imports.reassign_cluster /
      // pages.delete_many). `sql.raw("")` is a no-op predicate.
      const pageFilter =
        input.pageIds && input.pageIds.length > 0
          ? sql`AND p.id = ANY(${sql.raw(
              `ARRAY[${input.pageIds.map((id) => `'${id}'::uuid`).join(",")}]`,
            )})`
          : sql.raw("");
      // Branch visibility (mirrors branchVisibilityFilter, alias-qualified):
      // main rows + rows branched to THIS chat. Without a branch context,
      // main-only — another chat's unpublished pages are not ours to touch.
      const pageBranchFilter = branchId
        ? sql` AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
        : sql` AND p.chat_branch_id IS NULL`;
      const templateBranchFilter = branchId
        ? sql` AND (t.chat_branch_id IS NULL OR t.chat_branch_id = ${branchId}::uuid)`
        : sql` AND t.chat_branch_id IS NULL`;

      const fbPageRows = (await tx.execute(sql`
        SELECT p.id::text AS id
        FROM pages p
        WHERE p.deleted_at IS NULL ${pageBranchFilter} ${pageFilter}
      `)) as unknown as Array<{ id: string }>;

      // Placements per page, branch-overlay first: branched runs read the
      // latest page_layout_snapshot (live page_modules is empty for them);
      // live runs fall through to the live page_modules reader.
      const layoutStatesByPage: Array<{
        pageId: string;
        state: Awaited<ReturnType<typeof loadPageLayoutStateWithBranchOverlay>>;
      }> = [];
      for (const p of fbPageRows) {
        layoutStatesByPage.push({
          pageId: p.id,
          state: await loadPageLayoutStateWithBranchOverlay(tx, p.id, branchId),
        });
      }

      // Chrome binds at the layout (issue #253) and `layout_modules.set`
      // writes LIVE rows even in branched chats, so the join holds for
      // both flows. This is where the header LOGO <img> lives.
      const fbChromeIdRows = (await tx.execute(sql`
        SELECT DISTINCT lm.module_id::text AS id
        FROM layout_modules lm
        JOIN templates t ON t.layout_id = lm.layout_id
        JOIN pages p ON p.template_id = t.id
        WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
          ${templateBranchFilter} ${pageBranchFilter} ${pageFilter}
      `)) as unknown as Array<{ id: string }>;

      // Resolve every referenced module's branch-latest text + provenance.
      const referencedModuleIds = new Set<string>();
      for (const { state } of layoutStatesByPage) {
        for (const block of state.blocks) {
          const ids =
            block.placements && block.placements.length > 0
              ? block.placements.map((pl) => pl.moduleId)
              : block.moduleIds;
          for (const id of ids) referencedModuleIds.add(id);
        }
      }
      for (const r of fbChromeIdRows) referencedModuleIds.add(r.id);
      const moduleTextById = new Map<string, ModuleTextWithProvenance>();
      for (const moduleId of referencedModuleIds) {
        const resolved = await loadModuleTextWithBranchProvenance(tx, moduleId, branchId);
        if (resolved) moduleTextById.set(moduleId, resolved);
      }

      const resolvedRows = resolveDirectBuildModuleRows({
        layoutStatesByPage,
        chromeModuleIds: fbChromeIdRows.map((r) => r.id),
        moduleTextById,
      });
      if (resolvedRows.missingModuleIds.length > 0) {
        // A placement references a module with no resolvable text
        // (deleted after placement?). Loud, not silent (CLAUDE.md §2).
        const msg = `media unit collection: ${resolvedRows.missingModuleIds.length} placed module(s) had no resolvable text and were skipped`;
        await logMediaRunEvent(tx, input.runId, "warning", msg, {
          missingModuleIds: resolvedRows.missingModuleIds,
        });
        console.warn(`[migrate_media] run=${input.runId} ${msg}`);
      }

      const fbTemplateIdRows = (await tx.execute(sql`
        SELECT DISTINCT t.id::text AS id
        FROM templates t
        JOIN pages p ON p.template_id = t.id
        WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL
          ${templateBranchFilter} ${pageBranchFilter} ${pageFilter}
      `)) as unknown as Array<{ id: string }>;
      const fbTemplateRows: TemplateCssRow[] = [];
      for (const t of fbTemplateIdRows) {
        const resolved = await loadTemplateWithBranchProvenance(tx, t.id, branchId);
        if (resolved && resolved.state.css !== "") {
          fbTemplateRows.push({
            id: t.id,
            css: resolved.state.css,
            templateState: resolved.state,
            fromBranchSnapshot: resolved.fromBranchSnapshot,
            liveChatBranchId: resolved.liveChatBranchId,
          });
        }
      }

      units = assembleDirectBuildUnits(
        {
          pageModules: resolvedRows.pageModules,
          chromeModules: resolvedRows.chromeModules,
          templates: fbTemplateRows,
        },
        run.source_url,
      );
      unitsBySource.directPageModules = resolvedRows.pageModules.length;
      unitsBySource.directChrome = resolvedRows.chromeModules.length;
      unitsBySource.directTemplates = fbTemplateRows.length;
    }

    // issue #302 — LOUD unit-collection telemetry: run ledger + console.
    // The console line survives a DB reset (which is exactly what erased
    // the run-15 evidence and made the zero-insert bug unattributable).
    if (units.length === 0) {
      const unitsWarning =
        "0 media units found — likely causes: (1) the pages for this run have not been " +
        "built or composed yet — build them first, then re-run migrate_media; (2) the pages " +
        "were built in a DIFFERENT chat — chat-built placements live on that chat's preview " +
        "branch and are invisible here, so re-run migrate_media from the chat that built the " +
        "pages (or after publishing them); (3) a pageIds filter excluded every built page. " +
        "Nothing was downloaded or rewritten.";
      await logMediaRunEvent(tx, input.runId, "warning", unitsWarning, {
        unitsBySource,
        chatBranchId: branchId,
        pageIdsFilter: input.pageIds?.length ?? 0,
      });
      console.warn(
        `[migrate_media] run=${input.runId} ${unitsWarning}`,
        JSON.stringify({ unitsBySource, chatBranchId: branchId }),
      );
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "imports.migrate_media",
        input,
        succeeded: true,
        entityId: input.runId,
        resultSummary: "units=0 (warning logged)",
      });
      return ok({
        migrated: 0,
        migratedBytes: 0,
        dedupedExisting: 0,
        alreadyLocal: 0,
        modulesRewritten: 0,
        templatesRewritten: 0,
        skipped: [],
        unitsBySource,
        unitsWarning,
        logoWarning: null,
      });
    }
    const unitsMessage =
      `media unit collection: ${units.length} rewritable unit(s) — ` +
      `compose(pageModules=${unitsBySource.composePageModules} chrome=${unitsBySource.composeChrome} templates=${unitsBySource.composeTemplates}) ` +
      `direct-build(pageModules=${unitsBySource.directPageModules} chrome=${unitsBySource.directChrome} templates=${unitsBySource.directTemplates})`;
    await logMediaRunEvent(tx, input.runId, "info", unitsMessage, {
      unitsBySource,
      chatBranchId: branchId,
    });
    console.info(`[migrate_media] run=${input.runId} ${unitsMessage}`);

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
    //
    // issue #302 — branched runs need TWO extra moves per rewritten unit:
    //   (a) Skip the live UPDATE when the unit's text came from a branched
    //       snapshot but the live row is MAIN-owned — writing branch-derived
    //       html into a main row would leak unpublished content.
    //   (b) Emit a branched snapshot carrying the REWRITTEN state. Branched
    //       creates/edits leave their pre-rewrite state as the branch-latest
    //       snapshot, and `chat.publish` replays that state over the live
    //       row — without (b) the media rewrite is silently reverted at
    //       publish and the published site hotlinks the source host again.
    // ------------------------------------------------------------------
    let modulesRewritten = 0;
    let templatesRewritten = 0;
    const usageDeltas: Record<string, number> = {};
    const rewrittenBranchEntities: SnapshotEntity[] = [];
    for (const unit of units) {
      const refs = perUnitRefs.get(unit);
      if (!refs) continue;
      const newHtml = unit.html === "" ? "" : rewriteAssetRefs(unit.html, refs.html, urlMap);
      const newCss = unit.css === "" ? "" : rewriteAssetRefs(unit.css, refs.css, urlMap);
      if (newHtml === unit.html && newCss === unit.css) continue;
      const liveUpdateWouldLeakBranchContent =
        branchId !== null && unit.fromBranchSnapshot === true && unit.liveChatBranchId === null;
      if (unit.kind === "module") {
        if (!liveUpdateWouldLeakBranchContent) {
          await tx.execute(sql`
            UPDATE modules SET html = ${newHtml}, css = ${newCss}
            WHERE id = ${unit.id}::uuid
          `);
        }
        if (branchId !== null && unit.moduleState !== undefined) {
          rewrittenBranchEntities.push({
            kind: "module",
            entityId: unit.id,
            state: { ...unit.moduleState, html: newHtml, css: newCss },
          });
        }
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
        if (!liveUpdateWouldLeakBranchContent) {
          await tx.execute(sql`
            UPDATE templates SET css = ${newCss} WHERE id = ${unit.id}::uuid
          `);
        }
        if (branchId !== null && unit.templateState !== undefined) {
          rewrittenBranchEntities.push({
            kind: "template",
            entityId: unit.id,
            state: { ...unit.templateState, css: newCss },
          });
        }
        templatesRewritten += 1;
      }
    }
    if (rewrittenBranchEntities.length > 0) {
      // One site_snapshots row for the whole rewrite — the branch-latest
      // state per entity now carries Caelo media URLs, so chat.publish
      // replays the rewritten text instead of the hotlinked original.
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.update",
        description: `imports.migrate_media rewrite run=${input.runId.slice(0, 8)}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: rewrittenBranchEntities,
      });
    }
    if (Object.keys(usageDeltas).length > 0) {
      // System-only op invoked through its handler — this op is the
      // boundary; the delta write is an internal bookkeeping step.
      await mediaRecordUsageOp.handler(ctx, { deltas: usageDeltas }, tx);
    }

    // ------------------------------------------------------------------
    // 5. Logo-preservation guardrail. Media has just been re-hosted, so
    // this is the moment of truth: if the source homepage header carried
    // a real logo image but the rebuilt chrome header references none of
    // {Caelo-media <img>, {{theme_logo_url}}, bound theme logo asset},
    // the operator's brand logo was hand-authored as a text/CSS wordmark
    // instead of imported (the searchviu live-run defect). Prose in the
    // skill forbids it; this is the structural backstop that makes the
    // miss LOUD in the run's error/warning ledger (CLAUDE.md §2, §11).
    // Conservative: fires only when a source logo image is positively
    // detected, so a genuine styled-text wordmark is never flagged.
    // ------------------------------------------------------------------
    const logoWarning = await detectRedrawnLogo(tx, input.runId, run.source_url);

    // issue #302 — LOUD download/rewrite telemetry: ledger + console.
    const summaryMessage =
      `media migration summary: units=${units.length} refs=${uniqueUrls.length} ` +
      `downloaded=${migrated} dedupedExisting=${dedupedExisting} alreadyLocal=${alreadyLocal} ` +
      `failed=${skipped.length} modulesRewritten=${modulesRewritten} templatesRewritten=${templatesRewritten} ` +
      `bytes=${migratedBytes} branchSnapshots=${rewrittenBranchEntities.length}`;
    await logMediaRunEvent(tx, input.runId, "info", summaryMessage, {
      unitsBySource,
      uniqueUrls: uniqueUrls.length,
      migrated,
      migratedBytes,
      dedupedExisting,
      alreadyLocal,
      skipped: skipped.length,
      modulesRewritten,
      templatesRewritten,
      branchSnapshots: rewrittenBranchEntities.length,
      chatBranchId: branchId,
    });
    console.info(`[migrate_media] run=${input.runId} ${summaryMessage}`);

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
      unitsBySource,
      unitsWarning: null,
      logoWarning,
    });
  },
});

/**
 * The logo-preservation guardrail's DB half. Reads (a) the crawled
 * homepage's extracted source blocks, (b) the rebuilt chrome header
 * module (post-rewrite, so a just-migrated logo shows its `/_caelo/`
 * src), and (c) the active theme's bound logo asset. Returns a warning
 * string when the source had a logo image and the rebuild references
 * none of the three logo signals — and appends that warning to the run's
 * `import_run_events` ledger in the same transaction (best-effort:
 * detection must never sink a media migration that actually moved
 * assets). Returns `null` when the logo was preserved or the source had
 * none.
 *
 * `tx` is the open Query-API transaction; `runId` the migration run;
 * `sourceUrl` the run's origin (used to find the homepage import_page).
 */
async function detectRedrawnLogo(
  tx: Parameters<typeof migrateImportMediaOp.handler>[2],
  runId: string,
  sourceUrl: string,
): Promise<string | null> {
  // Source signal: the homepage import_page's extracted blocks. Prefer
  // the row whose source_url matches the run origin; fall back to the
  // earliest-crawled page for the run (the homepage is crawled first).
  const homepageRows = (await tx.execute(sql`
    SELECT proposed_modules
    FROM import_pages
    WHERE run_id = ${runId}::uuid
    ORDER BY (source_url = ${sourceUrl}) DESC, created_at ASC
    LIMIT 1
  `)) as unknown as Array<{ proposed_modules: unknown }>;
  const blocks = (homepageRows[0]?.proposed_modules ?? []) as ProposedModuleBlock[];
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  const sourceLogo = sourceHeaderHasLogoImage(blocks);
  if (!sourceLogo.hasLogo) return null;

  // Rebuild signal 1+2: the rebuilt chrome header module(s), re-read
  // AFTER the rewrite above so a migrated logo <img> already carries its
  // /_caelo/ src. Two ways the header is attached, checked together so the
  // guardrail evaluates the REAL header regardless of build path:
  //   (a) compose flow — a module named `imported-<runid8>-header`,
  //   (b) direct-build flow (#278) — a module bound to the layout's
  //       `header` block via layout_modules (no import-slug convention).
  // If EITHER header carries a real logo ref, the logo was preserved.
  const headerRows = (await tx.execute(sql`
    SELECT m.html
    FROM modules m
    WHERE m.deleted_at IS NULL AND (
      m.slug = ${`imported-${runId.slice(0, 8)}-header`}
      OR m.id IN (
        SELECT lm.module_id
        FROM layout_modules lm
        JOIN templates t ON t.layout_id = lm.layout_id
        JOIN pages p ON p.template_id = t.id
        WHERE lm.block_name = 'header' AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      )
    )
  `)) as unknown as Array<{ html: string }>;
  for (const row of headerRows) {
    if (rebuiltHeaderHasLogoRef(row.html ?? "")) return null;
  }

  // Rebuild signal 3: a bound theme logo asset (set via themes.set_asset
  // + a {{theme_logo_url}} the template engine resolves). If the operator
  // bound the logo at the theme, the header need not carry it inline.
  const themeRows = (await tx.execute(sql`
    SELECT logo_media_id::text AS logo_media_id FROM themes WHERE is_active = true LIMIT 1
  `)) as unknown as Array<{ logo_media_id: string | null }>;
  if (themeRows[0]?.logo_media_id) return null;

  // All three signals absent → the logo was redrawn. Record it LOUDLY.
  const message =
    `header logo was NOT imported: the source homepage header carried a real logo asset ` +
    `(${sourceLogo.evidence ?? "image"}) but the rebuilt header references neither a Caelo-hosted ` +
    `logo <img>, a {{theme_logo_url}} placeholder, nor a bound theme logo asset — it was likely ` +
    `hand-authored as a text/CSS wordmark. Preserve the source logo as a real <img> (so migrate_media ` +
    `re-hosts it) or bind it once with set_theme_asset({slot:'logo'}) + {{theme_logo_url}}, then re-run.`;
  await tx.execute(sql`
    INSERT INTO import_run_events (run_id, severity, phase, message, detail)
    VALUES (
      ${runId}::uuid,
      'warning',
      'media',
      ${message},
      ${jsonbParam({ check: "logo-preserved", sourceEvidence: sourceLogo.evidence ?? null })}
    )
  `);
  return message;
}
