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
 * negative result (NULL) so the next op call still answers fast. The fetch
 * and the cache write live in platform-updates/release-check.ts, shared
 * with Settings → Updates' "Check now".
 *
 * Bootstrapped once per process from apps/admin/src/hooks.server.ts —
 * same pattern as startRedeployOrchestrator.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "./audit.js";
import {
  fetchLatestRelease,
  predictReleaseRoute,
  type RoutePredictionOpts,
  writeReleaseCheck,
} from "./platform-updates/release-check.js";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface ReleaseCheckWorkerOpts extends RoutePredictionOpts {
  readonly adapter: DatabaseAdapter;
  /** Override poll interval (ms). Tests pass a small value; production uses default. */
  readonly intervalMs?: number;
  /** Override fetch URL — tests / forks. */
  readonly url?: string;
}

let workerHandle: ReturnType<typeof setInterval> | null = null;
let polls = 0;

async function pollOnce(opts: ReleaseCheckWorkerOpts): Promise<void> {
  // The fetch first, outside the transaction; a failure is cached as "no
  // release" with the time, so the page says the last check failed. The 1h
  // cadence retries automatically.
  // The release's route (does it change the cloud setup, #817) is read
  // from its manifest here too, so the page knows it before the Owner clicks.
  const outcome = await predictReleaseRoute(
    await fetchLatestRelease(opts.url ? { url: opts.url } : {}),
    opts,
  );
  await opts.adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `release-check-${polls++}` },
    (tx) => writeReleaseCheck(tx, outcome),
  );
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
    console.error("[release-check-worker] initial poll failed:", (e as Error).message);
  });
  workerHandle = setInterval(() => {
    void pollOnce(opts).catch((e) => {
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
