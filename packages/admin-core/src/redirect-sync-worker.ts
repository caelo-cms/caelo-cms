// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — runs the redirect sync after redirects writes and retries the
 * targets whose provider is behind.
 *
 * Starting the worker registers the post-commit runner every redirects write
 * uses (deploy/redirect-sync.ts `setRedirectSyncRunner`), so a save pushes
 * the table to the hosting provider before its request answers. A push that
 * failed leaves its target behind (`redirect_sync_state.wanted_revision >
 * synced_revision`) with a `next_attempt_at` that backs off from 1 minute to
 * an hour; this worker's poll retries every target that is due. The poll is
 * one indexed read while everything is in sync.
 *
 * Bootstrapped once per admin process from apps/admin/src/hooks.server.ts,
 * same pattern as release-check-worker.ts.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { describeError } from "./ai/tools/_describe-error.js";
import { SYSTEM_ACTOR_ID } from "./audit.js";
import {
  type RedirectSyncOutcome,
  type RedirectSyncTrigger,
  setRedirectSyncRunner,
} from "./deploy/redirect-sync.js";

const POLL_INTERVAL_MS = 60 * 1000;

interface RedirectSyncWorkerOpts {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Override the poll interval (ms). */
  readonly intervalMs?: number;
}

let workerHandle: ReturnType<typeof setInterval> | null = null;
let runs = 0;

/** Run `redirects.sync_provider` as the system actor; throws when the op itself fails. */
async function runSync(
  opts: RedirectSyncWorkerOpts,
  trigger: RedirectSyncTrigger,
  targetIds?: readonly string[],
): Promise<RedirectSyncOutcome[]> {
  const r = await execute(
    opts.registry,
    opts.adapter,
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `redirect-sync-${runs++}` },
    "redirects.sync_provider",
    { trigger, ...(targetIds ? { targetIds: [...targetIds] } : {}) },
  );
  if (!r.ok) throw new Error(`redirects.sync_provider failed: ${describeError(r.error)}`);
  return (r.value as { targets: RedirectSyncOutcome[] }).targets;
}

/** One poll: retry the targets that are behind and whose backoff has elapsed. */
async function pollOnce(opts: RedirectSyncWorkerOpts): Promise<void> {
  const due = (await opts.adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `redirect-sync-poll-${runs++}` },
    async (tx) =>
      tx.execute(sql`
        SELECT target_id::text AS target_id FROM redirect_sync_state
        WHERE wanted_revision > synced_revision
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      `),
  )) as unknown as { target_id: string }[];
  if (due.length === 0) return;
  // Only the due ones: another target may still be backing off.
  const outcomes = await runSync(
    opts,
    "retry",
    due.map((d) => d.target_id),
  );
  for (const o of outcomes.filter((x) => x.status === "failed")) {
    console.error("[redirect-sync-worker] the redirects are still not live", {
      target: o.targetName,
      error: o.error,
    });
  }
}

/**
 * Register the post-commit runner and start the retry poll. Idempotent —
 * a second call is a no-op.
 */
export function startRedirectSyncWorker(opts: RedirectSyncWorkerOpts): void {
  if (workerHandle) return;
  setRedirectSyncRunner((trigger) => runSync(opts, trigger));
  const tick = () => {
    void pollOnce(opts).catch((e) => {
      console.error("[redirect-sync-worker] retry poll failed:", (e as Error).message);
    });
  };
  tick();
  workerHandle = setInterval(tick, opts.intervalMs ?? POLL_INTERVAL_MS);
}

/** Test-only — stop the poll and unregister the runner. */
export function stopRedirectSyncWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
  setRedirectSyncRunner(null);
}

/** Test-only — one retry poll, awaited. */
export const _redirectSyncPollOnceForTests = pollOnce;
