// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — the site-import crawl worker. Every 10 seconds it claims at most
 * one `import_runs` row in status 'crawling' (fresh, or a zombie whose
 * heartbeat went stale) and crawls it, streaming batches, checkpoints and
 * screenshots to the database as it goes (issues #192, #423).
 *
 * Started once per admin process from `apps/admin/src/hooks.server.ts`,
 * like the other background loops. It lived in the redeploy orchestrator
 * until the automatic redeploy was removed (#1154); its cadence moves to
 * the scheduler tick under epic #1140.
 */

import { createHash } from "node:crypto";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type CrawlCheckpoint,
  type CrawledPage,
  crawlSite,
  type Screenshot,
} from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";
import { getExternalScreenshotter } from "../ai/tools/_external-screenshotter.js";
import { parseCrawlScope } from "./crawl-scope.js";
import { parseExplicitUrls } from "./explicit-urls.js";
import {
  captureImportGroundTruth,
  importerAllowedHosts,
  persistBatchCapture,
  writeRunDesignTokenAggregate,
} from "./ground-truth.js";

/** issue #423 — deterministic per-URL storage suffix so re-captures and
 *  resume replays overwrite the same object instead of accumulating. */
function urlKeyFragment(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * issue #192 — revive a checkpointed frontier from the claimed row.
 * Shape-checked defensively: a malformed checkpoint (schema drift,
 * manual edit) restarts the crawl instead of crashing the tick — the
 * DB's UNIQUE(run_id, source_url) absorbs the replay.
 */
function parseCrawlCheckpoint(raw: unknown): CrawlCheckpoint | null {
  const v = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (typeof v !== "object" || v === null) return null;
  const cp = v as Partial<CrawlCheckpoint>;
  if (!Array.isArray(cp.queue) || !Array.isArray(cp.seen)) return null;
  if (typeof cp.pagesCrawled !== "number") return null;
  return {
    queue: cp.queue.filter(
      (q): q is { url: string; depth: number } =>
        typeof q === "object" && q !== null && typeof (q as { url?: unknown }).url === "string",
    ),
    seen: cp.seen.filter((x): x is string => typeof x === "string"),
    pagesCrawled: cp.pagesCrawled,
    errors: Array.isArray(cp.errors)
      ? cp.errors.filter(
          (e): e is { url: string; reason: string } =>
            typeof e === "object" && e !== null && typeof (e as { url?: unknown }).url === "string",
        )
      : [],
    // issue #425 — the skip ledger joined the checkpoint later; an old
    // in-flight checkpoint without it resumes with an empty ledger.
    // Both fields are checked (PR #435 review): an entry missing its
    // `reason` must not reach the report claiming to have one.
    skipped: Array.isArray(cp.skipped)
      ? cp.skipped.filter(
          (e): e is { url: string; reason: string } =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as { url?: unknown }).url === "string" &&
            typeof (e as { reason?: unknown }).reason === "string",
        )
      : [],
    skippedOutOfScope: typeof cp.skippedOutOfScope === "number" ? cp.skippedOutOfScope : 0,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "site-import",
};

/** Poll interval: one crawl claim per tick. */
const CRAWL_INTERVAL_MS = 10_000;

/** What the crawl worker needs. */
export interface SiteImportWorkerConfig {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /**
   * issue #198 — sink for import screenshots (the admin app wires its
   * media storage in). Absent = captures are diffed but not persisted
   * (pre-#198 behaviour), which the run records via the NULL keys.
   */
  readonly screenshotStorage?: {
    put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  };
}

/**
 * P14 — one tick of the Site Import Wizard worker. Picks up at most ONE
 * `import_runs` row at status='crawling', runs the crawler, writes
 * extracted pages, flips status to 'ready_for_review' (or 'failed' on
 * error). Owner kicks off the crawl via /settings/import →
 * imports.create_run; the AI path is imports.propose_run + Owner approve.
 * The worker calls it on its interval.
 */
async function crawlNextImportRun(cfg: SiteImportWorkerConfig): Promise<void> {
  let runId: string | undefined;
  try {
    // Claim one crawling run atomically. FOR UPDATE SKIP LOCKED so a
    // multi-replica admin can't double-claim a row even if both
    // poll on the same tick. The UPDATE that flips started_at runs
    // inside the same tx so the row is owned for the whole crawl
    // window.
    //
    // issue #192 — two claimable shapes:
    //   - fresh runs (started_at IS NULL), and
    //   - ZOMBIES: 'crawling' runs whose heartbeat went stale (worker
    //     crashed mid-crawl). Pre-#192 these sat in 'crawling'
    //     forever. The 15-minute staleness window comfortably exceeds
    //     the worst-case gap between batch flushes (25 pages × 20s
    //     fetch timeout ≈ 8 min).
    const rows = await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
      const claim = (await tx.execute(sql`
          SELECT id::text AS id, source_url, depth, max_pages, explicit_urls, crawl_scope, crawl_state
          FROM import_runs
          WHERE status = 'crawling'
            AND (
              started_at IS NULL
              OR COALESCE(heartbeat_at, started_at) < now() - interval '15 minutes'
            )
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `)) as unknown as Array<{
        id: string;
        source_url: string;
        depth: number;
        max_pages: number;
        explicit_urls: unknown;
        crawl_scope: unknown;
        crawl_state: unknown;
      }>;
      if (claim.length > 0) {
        await tx.execute(
          sql`UPDATE import_runs SET started_at = now(), heartbeat_at = now() WHERE id = ${claim[0]?.id}::uuid`,
        );
      }
      return claim;
    });
    const r = rows[0];
    if (!r) return;
    runId = r.id;
    const sourceUrl = r.source_url;
    const depth = r.depth;
    const maxPages = r.max_pages;
    // issue #229 — LIST mode: the proposal pinned an exact URL set. The
    // crawler fetches only these (+ the source origin), no BFS. jsonb
    // may decode to an array or a JSON string depending on the client.
    // A present-but-malformed value THROWS (run goes 'failed' with the
    // structured message below) instead of silently degrading to BFS —
    // the Owner approved an exact set, not a depth crawl (§2
    // no-fallbacks). Only SQL NULL means depth mode.
    const explicitUrls = parseExplicitUrls(r.explicit_urls);
    // issue #425 — same loudness contract as explicit_urls: SQL NULL =
    // unscoped; a present-but-malformed scope THROWS (run goes 'failed')
    // instead of silently crawling outside the Owner-approved scope.
    const crawlScope = parseCrawlScope(r.crawl_scope);
    const resumeFrom = parseCrawlCheckpoint(r.crawl_state);
    const claimedRunId = runId;
    // issue #423 — crawl-time ground truth. The crawler streams each
    // page's screenshot out the moment the page is accepted (PNG bytes
    // never buffer across a batch); we upload immediately and remember
    // only url → object key. A throwing sink lands in the run's error
    // list via the crawler (loud), and the page stays keyless so the
    // post-crawl pass below re-attempts + notes it.
    const storage = cfg.screenshotStorage;
    const screenshotKeyByUrl = new Map<string, string>();
    const onPageCapture = storage
      ? async ({ url, screenshot }: { url: string; screenshot: Screenshot }): Promise<void> => {
          const key = `import-screenshots/${claimedRunId}/src-${urlKeyFragment(url)}.png`;
          await storage.put(key, screenshot.bytes, "image/png");
          screenshotKeyByUrl.set(url, key);
        }
      : undefined;
    const flushBatch = async (pages: CrawledPage[]): Promise<void> => {
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.write_extracted_pages", {
        runId: claimedRunId,
        pages: pages.map((p) => ({
          // issue #425 — `p.url` is the FINAL post-redirect URL; the
          // requested URL rides along as provenance when they differ.
          sourceUrl: p.url,
          ...(p.requestedUrl !== undefined ? { requestedUrl: p.requestedUrl } : {}),
          proposedSlug: p.proposedSlug,
          proposedTitle: p.title,
          // Bounded like every stored crawl field; the AI shortens it to
          // the 160-character target when it carries it over anyway.
          sourceMetaDescription: p.metaDescription.slice(0, 2000),
          proposedModules: p.modules.map((m) => ({
            blockName: m.blockName,
            position: m.position,
            html: m.html,
            displayName: m.displayName,
          })),
          proposedThemeTokens: p.themeTokens,
          signature: p.signature,
          pageCss: p.pageCss,
          // run #10 D3 — loud counter from the extractor's
          // comment-thread stripper; persisted as a visible
          // `comments-stripped:<n>` note on the import page.
          commentsStripped: p.commentsStripped,
        })),
      });
      // issue #423 — land the batch's visual ground truth (screenshot
      // keys uploaded by onPageCapture + tokens derived from the SAME
      // render session's style samples) right after the rows exist.
      await persistBatchCapture({
        runId: claimedRunId,
        registry: cfg.registry,
        adapter: cfg.adapter,
        pages,
        screenshotKeyByUrl,
      });
    };
    const result = await crawlSite({
      sourceUrl,
      depth,
      maxPages,
      // issue #229 — present ⇒ LIST mode (crawler ignores depth/maxPages
      // BFS and fetches exactly these + the source origin). Non-null is
      // guaranteed non-empty by parseExplicitUrls.
      ...(explicitUrls ? { urls: explicitUrls } : {}),
      // issue #425 — the Owner-approved language/section scope.
      ...(crawlScope ? { scope: crawlScope } : {}),
      throttleMs: 100,
      // issue #191 — explicit, visible exemption list for the SSRF
      // guard (e2e fixture servers, deliberate private crawls).
      allowedHosts: importerAllowedHosts(),
      // issue #1217 — the install's one screenshotter: the capture job on
      // GCP, the shared one-at-a-time browser on self-hosted installs. Never
      // a browser of the crawl's own next to it.
      screenshotter: await getExternalScreenshotter({ allowedHosts: importerAllowedHosts() }),
      // issue #192 — stream batches to the DB (UNIQUE(run_id,
      // source_url) makes resume replays idempotent) + checkpoint the
      // frontier so a crash resumes instead of restarting.
      ...(resumeFrom ? { resumeFrom } : {}),
      onBatch: flushBatch,
      // issue #423 — pixels stream out per page; see onPageCapture above.
      ...(onPageCapture ? { onPageCapture } : {}),
      onCheckpoint: async (cp) => {
        await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
          await tx.execute(sql`
            UPDATE import_runs
            SET crawl_state = (${JSON.stringify(cp)}::text)::jsonb, heartbeat_at = now()
            WHERE id = ${claimedRunId}::uuid
          `);
        });
      },
    });
    // issue #247 (WS1) — ground-truth pass, ALWAYS on. issue #423 —
    // now scoped to pages that STILL lack a stored screenshot after the
    // crawl-time capture above (fetch-only crawls, resumed runs, pages
    // whose capture failed mid-crawl): those get the retry-once →
    // loud-note treatment (epic #252 ruling); pages already captured
    // are skipped, so the happy path renders each page exactly once.
    // When capture cannot happen at all (no Playwright, dead page, no
    // storage) every affected page still gets a loud
    // `screenshot_missing` note instead of a silent NULL (F9).
    await captureImportGroundTruth({
      runId,
      adapter: cfg.adapter,
      registry: cfg.registry,
      onlyPagesMissingScreenshot: true,
      ...(cfg.screenshotStorage ? { screenshotStorage: cfg.screenshotStorage } : {}),
    });
    // issue #423 — run-level token aggregate from ALL pages' sampled
    // tokens (crawl-time + after-pass), read back from the rows so
    // neither pass clobbers the other's contribution.
    await writeRunDesignTokenAggregate({
      runId,
      adapter: cfg.adapter,
      registry: cfg.registry,
    });
    await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.update_run_status", {
      runId,
      status: "ready_for_review",
      pagesSeen: result.seenCount,
      pagesExtracted: result.pagesCrawled,
    });
    // Frontier no longer needed once the run left 'crawling'; keep
    // the error list queryable for the migration report (#197) — and
    // the #425 skip ledger + scope, so the report states what the
    // scope declined, loudly.
    await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
      await tx.execute(sql`
        UPDATE import_runs
        SET crawl_state = (${JSON.stringify({
          errors: result.errors,
          skipped: result.skipped,
          skippedOutOfScope: result.skippedOutOfScope,
        })}::text)::jsonb,
            heartbeat_at = NULL
        WHERE id = ${claimedRunId}::uuid
      `);
    });
  } catch (e) {
    if (runId) {
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.update_run_status", {
        runId,
        status: "failed",
        errorMessage: (e as Error).message.slice(0, 1000),
      }).catch(() => undefined);
    }
  }
}

/**
 * Start the crawl loop. Returns a stop handle (tests; the admin process
 * runs it for its lifetime).
 */
export function startSiteImportWorker(cfg: SiteImportWorkerConfig): { stop(): void } {
  const handle = setInterval(() => {
    void crawlNextImportRun(cfg);
  }, CRAWL_INTERVAL_MS);
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
