// SPDX-License-Identifier: MPL-2.0

/**
 * P21 ship 5 — periodically polls GitHub for the latest Caelo release
 * and writes the result to `release_check_cache` (singleton row).
 *
 * Why this exists: P20 ship 4 inlined the GitHub fetch inside
 * `notifications.aggregate`'s op handler — which runs INSIDE a
 * Postgres transaction. A slow GitHub held the connection open for
 * up to 5s, opening a connection-pool exhaustion vector. The fetch
 * is now hoisted out: this worker runs in the background, the op
 * just reads the cached row.
 *
 * Cadence: 1h. AbortSignal timeout 5s per fetch. Failures cache the
 * negative result (NULL) so the next op call still answers fast.
 *
 * Bootstrapped once per process from apps/admin/src/hooks.server.ts —
 * same pattern as startTranslationWorker / startRedeployOrchestrator.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5_000;
const GITHUB_LATEST_URL = "https://api.github.com/repos/caelo-cms/caelo-cms/releases/latest";

interface ReleaseCheckWorkerOpts {
  readonly adapter: DatabaseAdapter;
  /** Override poll interval (ms). Tests pass a small value; production uses default. */
  readonly intervalMs?: number;
  /** Override fetch URL — tests / forks. */
  readonly url?: string;
}

let workerHandle: ReturnType<typeof setInterval> | null = null;

async function pollOnce(opts: ReleaseCheckWorkerOpts): Promise<void> {
  const url = opts.url ?? GITHUB_LATEST_URL;
  let latestVersion: string | null = null;
  let releaseUrl: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = (await res.json()) as { tag_name?: string; html_url?: string };
      latestVersion = json.tag_name?.replace(/^v/, "") ?? null;
      releaseUrl = json.html_url ?? null;
    }
  } catch {
    // Network failure / abort / parse error — write NULL so callers
    // know the last poll didn't reach GitHub. The 1h cadence retries
    // automatically; nothing else needs to know.
  }

  await opts.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      UPDATE release_check_cache
         SET latest_version = ${latestVersion},
             release_url    = ${releaseUrl},
             fetched_at     = now()
       WHERE id = 1
    `;
  });
}

/**
 * Start the periodic poller. Idempotent — second call is a no-op.
 * Call from hooks.server.ts boot.
 */
export function startReleaseCheckWorker(opts: ReleaseCheckWorkerOpts): void {
  if (workerHandle) return;
  // Initial poll immediately (so the first request after admin boot
  // doesn't sit at upgradeAvailable=false for an hour). Failures
  // surface as a console.error but don't crash the boot.
  void pollOnce(opts).catch((e) => {
    // biome-ignore lint/suspicious/noConsole: worker error
    console.error("[release-check-worker] initial poll failed:", (e as Error).message);
  });
  workerHandle = setInterval(() => {
    void pollOnce(opts).catch((e) => {
      // biome-ignore lint/suspicious/noConsole: worker error
      console.error("[release-check-worker] poll failed:", (e as Error).message);
    });
  }, opts.intervalMs ?? POLL_INTERVAL_MS);
}

/** Test-only — stops the worker so a fresh `start*` call is a no-op-free. */
export function stopReleaseCheckWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}
