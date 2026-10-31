// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the change journal's retention GC (it replaces the
 * domain-event outbox GC of #392). Runs `change_journal.collect_garbage`
 * on an interval; the op deletes rows past the retention window and
 * records the horizon consumers compare their cursor with.
 *
 * Same bootstrap pattern as proposal-gc-worker.ts; called from
 * hooks.server.ts. Moves to the #1140 scheduler tick with the other
 * maintenance loops.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

const INTERVAL_MS = 60 * 60 * 1000;

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000000",
  actorKind: "system",
  requestId: "change-journal-gc",
};

let handle: ReturnType<typeof setInterval> | null = null;

/** Calls one pass makes at most (each a short transaction of one batch): a million rows. */
const MAX_CALLS_PER_PASS = 100;

async function sweep(adapter: DatabaseAdapter, registry: OperationRegistry): Promise<void> {
  for (let i = 0; i < MAX_CALLS_PER_PASS; i++) {
    const r = await execute(registry, adapter, SYSTEM_CTX, "change_journal.collect_garbage", {});
    if (!r.ok) {
      process.stderr.write(`[change-journal-gc] sweep failed: ${JSON.stringify(r.error)}\n`);
      return;
    }
    if (!(r.value as { more: boolean }).more) return;
  }
}

/** Start the periodic journal GC. Idempotent — a second call is a no-op. */
export function startChangeJournalGcWorker(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): void {
  if (handle) return;
  void sweep(opts.adapter, opts.registry);
  handle = setInterval(() => void sweep(opts.adapter, opts.registry), INTERVAL_MS);
  handle.unref?.();
}

/** Test-only — stop the worker so a fresh start is not a no-op. */
export function stopChangeJournalGcWorker(): void {
  if (handle) clearInterval(handle);
  handle = null;
}
