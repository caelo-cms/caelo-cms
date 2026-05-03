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
  computeDiffStatus,
  computePixelDiff,
  crawlSite,
  createPlaywrightScreenshotter,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { sql } from "drizzle-orm";

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
    // id directly; ops on `comments.moderate` etc. typically attach the
    // page id via the page-relevance join — for v1 we treat any
    // entity_id we see as a page candidate. The generator filter is a
    // narrow whitelist so any non-page id silently no-ops.
    for (const r of rows) {
      if (r.entity_id && r.operation.startsWith("pages.")) {
        pendingPageIds.add(r.entity_id);
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
      // window — concurrent ticks see started_at IS NOT NULL and skip.
      const rows = await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        const claim = (await tx.execute(sql`
            SELECT id::text AS id, source_url, depth, max_pages
            FROM import_runs
            WHERE status = 'crawling' AND started_at IS NULL
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `)) as unknown as Array<{
          id: string;
          source_url: string;
          depth: number;
          max_pages: number;
        }>;
        if (claim.length > 0) {
          await tx.execute(
            sql`UPDATE import_runs SET started_at = now() WHERE id = ${claim[0]?.id}::uuid`,
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
      const result = await crawlSite({ sourceUrl, depth, maxPages, throttleMs: 100 });
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.write_extracted_pages", {
        runId,
        pages: result.pages.map((p) => ({
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
        pagesExtracted: result.pages.length,
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
    args.screenshotter !== undefined ? args.screenshotter : await createPlaywrightScreenshotter();
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
        const sourceShot = await screenshotter.capture(p.sourceUrl);
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
