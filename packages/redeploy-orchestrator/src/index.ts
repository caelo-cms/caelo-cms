// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/redeploy-orchestrator — debounced auto-redeploy.
 *
 * Polls the `audit_events` tail every `pollIntervalMs` (default 1500ms)
 * and watches for "publishable" op kinds (configurable via
 * `site_settings.auto_redeploy_op_kinds`). When an event arrives, a
 * timer is armed for `auto_redeploy_debounce_ms` (default 12000ms).
 * Subsequent events within the window reset the timer. When the timer
 * fires, dispatches `deploy.trigger({env:'production', initiator:'auto'})`
 * and drains the inflight set.
 *
 * Polling (vs LISTEN/NOTIFY) keeps the implementation portable across
 * pgbouncer modes + cloud-managed Postgres without needing to wire a
 * dedicated long-lived connection per replica. The poll cost is
 * trivial — one indexed timestamp range query per tick.
 *
 * Also runs the gateway-log + pow-challenges GC sweep every hour:
 *   - DELETE FROM gateway_request_log WHERE created_at < now() - '90 days'.
 *   - DELETE FROM pow_challenges WHERE expires_at < now() - '1 hour'.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type CrawlCheckpoint,
  type CrawledPage,
  computeDiffStatus,
  computePixelDiff,
  crawlSite,
  createPlaywrightScreenshotter,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";

/**
 * issue #191 — hostnames the importer's SSRF guard exempts. Set
 * CAELO_IMPORTER_ALLOWED_HOSTS to a comma-list of exact hostnames.
 * Exists for e2e fixture servers and deliberate private-network
 * crawls; empty (fully guarded) everywhere else.
 */
function importerAllowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
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
  requestId: "redeploy-orchestrator",
};

export interface OrchestratorConfig {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Defaults to 1500ms. */
  readonly pollIntervalMs?: number;
  /** Defaults to one hour. */
  readonly gcIntervalMs?: number;
}

export interface OrchestratorHandle {
  stop(): void;
  /** For tests + manual triggers. */
  flushPending(): Promise<void>;
}

interface Settings {
  enabled: boolean;
  debounceMs: number;
  opKinds: string[];
}

/**
 * v0.2.16 — resolve a plugin write op + its entity_id to the page_id
 * the operation logically affects, so auto-redeploy can rebuild only
 * that page. Each entry queries the plugin's own cms_public table.
 * Adding a new plugin op = adding a switch case below; no schema
 * change needed.
 */
async function resolvePluginOpPageId(
  adapter: DatabaseAdapter,
  operation: string,
  entityId: string,
): Promise<string | null> {
  // Comments — `comments.moderate` + bulk variant. entity_id is the
  // comment id; lookup table is cms_public.plugin_comments.comments.
  if (operation === "comments.moderate" || operation === "comments.moderate_bulk") {
    try {
      const pub = adapter.rawPublic();
      const rows = (await pub`
        SELECT page_id::text AS page_id FROM plugin_comments.comments
        WHERE id = ${entityId}::uuid LIMIT 1
      `) as unknown as { page_id: string | null }[];
      return rows[0]?.page_id ?? null;
    } catch {
      return null;
    }
  }
  // Ratings — `ratings.submit` writes a row + updates aggregates.
  // entity_id is the rating id; lookup is plugin_ratings.ratings.
  if (operation === "ratings.submit") {
    try {
      const pub = adapter.rawPublic();
      const rows = (await pub`
        SELECT page_id::text AS page_id FROM plugin_ratings.ratings
        WHERE id = ${entityId}::uuid LIMIT 1
      `) as unknown as { page_id: string | null }[];
      return rows[0]?.page_id ?? null;
    } catch {
      return null;
    }
  }
  // Forms / newsletter ops have no per-page binding (form submissions
  // and newsletter signups don't change a particular page's bake), so
  // they intentionally don't appear here. If a future plugin op should
  // trigger a per-page rebuild, add a case + the lookup query.
  return null;
}

export function startRedeployOrchestrator(cfg: OrchestratorConfig): OrchestratorHandle {
  const pollMs = cfg.pollIntervalMs ?? 1500;
  const gcMs = cfg.gcIntervalMs ?? 60 * 60 * 1000;
  // P13 audit re-pass — load the persisted offset on boot so a restart
  // doesn't drop events that landed during downtime. Initialised to
  // `now()` only when the column is missing entirely (fresh DB without
  // the migration); the seed default in 0041 covers the live path.
  let lastSeenAt = new Date();
  let lastPersistedSeenAt = new Date(0);
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // P13 ideas-pass — accumulate touched page ids since the last fire.
  // Drained on `fireDeploy()`; passed into deploy.trigger so the static
  // generator only re-bakes the changed subset.
  const pendingPageIds = new Set<string>();

  async function loadSettings(): Promise<Settings & { lastSeenAt: Date }> {
    const rows = await cfg.adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) =>
        (await tx.execute(sql`
        SELECT auto_redeploy_enabled      AS enabled,
               auto_redeploy_debounce_ms  AS debounce_ms,
               auto_redeploy_op_kinds     AS op_kinds,
               auto_redeploy_last_seen_at AS last_seen_at
        FROM site_settings WHERE id = 1 LIMIT 1
      `)) as unknown as Array<{
          enabled: boolean;
          debounce_ms: number;
          op_kinds: string[];
          last_seen_at: string | Date;
        }>,
    );
    const r = rows[0];
    const persisted = r?.last_seen_at
      ? r.last_seen_at instanceof Date
        ? r.last_seen_at
        : new Date(String(r.last_seen_at))
      : new Date();
    return {
      enabled: r?.enabled ?? false,
      debounceMs: r?.debounce_ms ?? 12000,
      opKinds: r?.op_kinds ?? [],
      lastSeenAt: persisted,
    };
  }

  async function persistLastSeen(at: Date): Promise<void> {
    if (at.getTime() <= lastPersistedSeenAt.getTime()) return;
    try {
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(
          sql`UPDATE site_settings SET auto_redeploy_last_seen_at = ${at.toISOString()} WHERE id = 1`,
        );
      });
      lastPersistedSeenAt = at;
    } catch {
      // best-effort
    }
  }

  // Hydrate the in-process watermark from the DB at boot.
  void loadSettings()
    .then((s) => {
      lastSeenAt = s.lastSeenAt;
      lastPersistedSeenAt = s.lastSeenAt;
    })
    .catch(() => undefined);

  async function fireDeploy(): Promise<void> {
    pendingTimer = null;
    const changed = [...pendingPageIds];
    pendingPageIds.clear();
    try {
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "deploy.trigger", {
        env: "production",
        initiator: "auto",
        // Empty/undefined = full-site rebuild. When non-empty the
        // generator filters its pages query to these ids only.
        ...(changed.length > 0 ? { changedPageIds: changed } : {}),
      });
    } catch {
      // Best-effort. If deploy.trigger op signature differs, the op
      // layer surfaces a structured error in audit; we just don't
      // crash the orchestrator.
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const settings = await loadSettings().catch(() => null);
    if (!settings?.enabled || settings.opKinds.length === 0) {
      return;
    }
    // P13 audit fix #6 — hard-exclude `deploy.trigger` regardless of
    // configured opKinds. The orchestrator fires deploy.trigger; if
    // that op kind ever lands in the allowlist we'd reentrantly arm
    // the timer on every fire, looping indefinitely.
    const safeOpKinds = settings.opKinds.filter((k) => k !== "deploy.trigger");
    if (safeOpKinds.length === 0) return;
    // Find audit_events newer than lastSeenAt with op IN (...).
    // P13 ideas-pass — also fetch entity_id so we can pass per-page
    // changedPageIds to the static generator (incremental rebuild).
    const rows = await cfg.adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) =>
        (await tx.execute(sql`
        SELECT created_at, entity_id::text AS entity_id, operation
        FROM audit_events
        WHERE created_at > ${lastSeenAt.toISOString()}::timestamptz
          AND operation = ANY(${safeOpKinds})
          AND succeeded = true
        ORDER BY created_at ASC
        LIMIT 500
      `)) as unknown as Array<{
          created_at: string | Date;
          entity_id: string | null;
          operation: string;
        }>,
    );
    if (rows.length === 0) return;
    // Collect per-page deltas. Operations on `pages.*` carry the page
    // id as `entity_id` directly. Plugin write ops carry their own
    // entity (e.g. `comments.moderate.entity_id` is the comment id);
    // for those we resolve the bound page_id from the plugin's
    // cms_public table so an approved comment auto-rebuilds only the
    // page it attaches to. Op-allowlist is intentionally narrow —
    // adding a new plugin op = one row in the resolver below.
    for (const r of rows) {
      if (r.entity_id && r.operation.startsWith("pages.")) {
        pendingPageIds.add(r.entity_id);
        continue;
      }
      if (r.entity_id) {
        const pageId = await resolvePluginOpPageId(cfg.adapter, r.operation, r.entity_id);
        if (pageId) pendingPageIds.add(pageId);
      }
    }
    const latest = rows[rows.length - 1]?.created_at;
    if (latest) {
      lastSeenAt = latest instanceof Date ? latest : new Date(String(latest));
      void persistLastSeen(lastSeenAt);
    }
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      void fireDeploy();
    }, settings.debounceMs);
  }

  /**
   * P14 — Site Import Wizard worker. Picks up at most ONE
   * `import_runs` row at status='crawling' per tick, runs the
   * crawler, writes extracted pages, flips status to
   * 'ready_for_review' (or 'failed' on error). Owner kicks off the
   * crawl via /security/import → imports.create_run; the AI path is
   * imports.propose_run + Owner approve.
   */
  async function importerTick(): Promise<void> {
    if (stopped) return;
    let runId: string | undefined;
    let sourceUrl: string | undefined;
    let depth = 2;
    let maxPages = 50;
    try {
      // Claim one crawling run atomically. FOR UPDATE SKIP LOCKED so a
      // multi-replica orchestrator can't double-claim a row even if both
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
            SELECT id::text AS id, source_url, depth, max_pages, crawl_state
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
      sourceUrl = r.source_url;
      depth = r.depth;
      maxPages = r.max_pages;
      const resumeFrom = parseCrawlCheckpoint(r.crawl_state);
      const claimedRunId = runId;
      const flushBatch = async (pages: CrawledPage[]): Promise<void> => {
        await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.write_extracted_pages", {
          runId: claimedRunId,
          pages: pages.map((p) => ({
            sourceUrl: p.url,
            proposedSlug: p.proposedSlug,
            proposedTitle: p.title,
            proposedModules: p.modules.map((m) => ({
              blockName: m.blockName,
              position: m.position,
              html: m.html,
              displayName: m.displayName,
            })),
            proposedThemeTokens: p.themeTokens,
          })),
        });
      };
      const result = await crawlSite({
        sourceUrl,
        depth,
        maxPages,
        throttleMs: 100,
        // issue #191 — explicit, visible exemption list for the SSRF
        // guard (e2e fixture servers, deliberate private crawls).
        allowedHosts: importerAllowedHosts(),
        // issue #192 — stream batches to the DB (UNIQUE(run_id,
        // source_url) makes resume replays idempotent) + checkpoint the
        // frontier so a crash resumes instead of restarting.
        ...(resumeFrom ? { resumeFrom } : {}),
        onBatch: flushBatch,
        onCheckpoint: async (cp) => {
          await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
            await tx.execute(sql`
              UPDATE import_runs
              SET crawl_state = ${JSON.stringify(cp)}::jsonb, heartbeat_at = now()
              WHERE id = ${claimedRunId}::uuid
            `);
          });
        },
      });
      // P14 polish — screenshot diff pass. For every page we just
      // staged, take a "ground truth" screenshot of the source URL +
      // a "rendered" screenshot of the staged Caelo preview, classify
      // via computeDiffStatus, and persist per-page. Skip silently when
      // Playwright isn't available (Tier 2 / cloud installs without
      // chromium pre-installed) — diff_status stays NULL, the gate
      // treats NULL as "non-blocking", and operators can still publish.
      // Gated by env so dev installs (no chromium) don't pay startup
      // cost: set CAELO_IMPORTER_SCREENSHOTS=1 to enable.
      if (process.env.CAELO_IMPORTER_SCREENSHOTS === "1") {
        await captureImportDiffs({
          runId,
          stagedPreviewBaseUrl: process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:5173",
          adapter: cfg.adapter,
          registry: cfg.registry,
        });
      }
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.update_run_status", {
        runId,
        status: "ready_for_review",
        pagesSeen: result.seenCount,
        pagesExtracted: result.pagesCrawled,
      });
      // Frontier no longer needed once the run left 'crawling'; keep
      // the error list queryable for the migration report (#197) by
      // storing only that slice.
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(sql`
          UPDATE import_runs
          SET crawl_state = ${JSON.stringify({ errors: result.errors })}::jsonb,
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

  async function gcSweep(): Promise<void> {
    if (stopped) return;
    try {
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(
          sql`DELETE FROM gateway_request_log WHERE created_at < now() - interval '90 days'`,
        );
        await tx.execute(
          sql`DELETE FROM pow_challenges WHERE expires_at < now() - interval '1 hour'`,
        );
        await tx.execute(
          sql`DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`,
        );
      });
    } catch {
      // best-effort
    }
  }

  const pollHandle = setInterval(() => {
    void tick();
  }, pollMs);
  const gcHandle = setInterval(() => {
    void gcSweep();
  }, gcMs);
  // P14 — importer tick every 10s; one crawl per tick so a long crawl
  // doesn't starve the auto-redeploy poller.
  const importerHandle = setInterval(() => {
    void importerTick();
  }, 10_000);

  return {
    stop(): void {
      stopped = true;
      clearInterval(pollHandle);
      clearInterval(gcHandle);
      clearInterval(importerHandle);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
    async flushPending(): Promise<void> {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        await fireDeploy();
      }
    },
  };
}

/**
 * P14 polish — for every import_pages row in `runId`, take a source
 * + staged screenshot pair, classify, and write the diff back. Skips
 * silently if Playwright/sharp aren't available so the importer still
 * works on installs that opted out of the chromium binary.
 *
 * Exported for the integration tests to drive directly without standing
 * up the polling orchestrator.
 */
export async function captureImportDiffs(args: {
  readonly runId: string;
  readonly stagedPreviewBaseUrl: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Optional override for tests; defaults to Playwright via dynamic import. */
  readonly screenshotter?: Screenshotter | null;
}): Promise<{ captured: number; failed: number }> {
  const screenshotter =
    args.screenshotter !== undefined
      ? args.screenshotter
      : await createPlaywrightScreenshotter({ allowedHosts: importerAllowedHosts() });
  if (!screenshotter) return { captured: 0, failed: 0 };

  let captured = 0;
  let failed = 0;
  try {
    const get = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.get", {
      runId: args.runId,
    });
    if (!get.ok) return { captured: 0, failed: 0 };
    const v = get.value as {
      pages: Array<{ id: string; sourceUrl: string; proposedSlug: string }>;
    };
    for (const p of v.pages) {
      try {
        // issue #191 — the source URL is third-party: guard it. The
        // staged capture below targets Caelo's own localhost preview
        // and must stay unguarded.
        const sourceShot = await screenshotter.capture(p.sourceUrl, { external: true });
        // The staged "rendered" view: the admin's edit-by-path
        // endpoint serves the live preview of the proposed page. We
        // hit it under `staged-import:<importPageId>` so the route can
        // resolve the right import_page row even before accept_page
        // promotes it. Falls back to a no-op screenshot when the route
        // isn't reachable.
        let stagedShot: Awaited<ReturnType<typeof screenshotter.capture>> | null = null;
        try {
          stagedShot = await screenshotter.capture(
            `${args.stagedPreviewBaseUrl}/edit/preview-by-path/en/${p.proposedSlug}`,
          );
        } catch {
          // staged preview unreachable — treat as a fail diff so the
          // operator's queue surfaces "could not render", not silently pass.
          stagedShot = null;
        }
        const diffPct = stagedShot ? await computePixelDiff(sourceShot, stagedShot) : 1;
        const classified = computeDiffStatus(diffPct);
        await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.update_page_diff", {
          importPageId: p.id,
          diffStatus: classified.status,
          diffPct: classified.diffPct,
        });
        captured += 1;
      } catch {
        failed += 1;
      }
    }
  } finally {
    await screenshotter.dispose().catch(() => undefined);
  }
  return { captured, failed };
}
