// SPDX-License-Identifier: MPL-2.0

/**
 * #392 — retention GC for the domain-event outbox.
 *
 * Events are ephemeral signals (snapshots remain the durable history),
 * so rows past the retention window are deleted outright. The window is
 * deliberately generous (14 days) relative to worker cadence (minutes):
 * a plugin whose worker was paused for the whole window has lost
 * signal, not data — its recovery path is a full re-scan through its
 * normal read handles, same as first activation.
 *
 * Same bootstrap pattern as proposal-gc-worker.ts; called from
 * hooks.server.ts.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface DomainEventGcWorkerOpts {
  readonly adapter: DatabaseAdapter;
  /** Override poll interval (ms). Tests pass smaller values. */
  readonly intervalMs?: number;
  /** Events older than this are pruned. */
  readonly retentionMs?: number;
}

let workerHandle: ReturnType<typeof setInterval> | null = null;

async function gcOnce(opts: DomainEventGcWorkerOpts): Promise<{ deleted: number }> {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const cutoffSeconds = Math.floor(retentionMs / 1000);
  let deleted = 0;
  await opts.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const result = (await tx.unsafe(
      `DELETE FROM domain_events
        WHERE created_at < now() - make_interval(secs => ${cutoffSeconds})
        RETURNING id`,
    )) as unknown as { id: string }[];
    deleted = result.length;
  });
  return { deleted };
}

/** Start the periodic outbox GC. Idempotent — second call is a no-op. */
export function startDomainEventGcWorker(opts: DomainEventGcWorkerOpts): void {
  if (workerHandle) return;
  void gcOnce(opts).catch((e) => {
    process.stderr.write(
      `[domain-event-gc-worker] initial sweep failed: ${(e as Error).message}\n`,
    );
  });
  workerHandle = setInterval(() => {
    void gcOnce(opts).catch((e) => {
      process.stderr.write(`[domain-event-gc-worker] sweep failed: ${(e as Error).message}\n`);
    });
  }, opts.intervalMs ?? POLL_INTERVAL_MS);
}

/** Test-only — stops the worker so a fresh start call isn't a no-op. */
export function stopDomainEventGcWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}

/** Test-only — runs one sweep synchronously for assertions. */
export const _domainEventGcOnceForTests = gcOnce;
