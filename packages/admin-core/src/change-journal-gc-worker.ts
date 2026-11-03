// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the change journal's retention GC (it replaces the
 * domain-event outbox GC of #392). Runs `change_journal.collect_garbage`
 * until nothing past the retention window is left; the op deletes rows in
 * batches and records the horizon consumers compare their cursor with.
 *
 * Runs on the scheduler tick (#1140, scheduler/core-tasks.ts), hourly.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000000",
  actorKind: "system",
  requestId: "change-journal-gc",
};

/** Calls one pass makes at most (each a short transaction of one batch): a million rows. */
const MAX_CALLS_PER_PASS = 100;

/**
 * One GC pass. Throws when the op fails; the rows it did not reach stay for
 * the next pass.
 *
 * @returns how many batches it ran
 */
export async function sweepChangeJournal(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<number> {
  for (let i = 0; i < MAX_CALLS_PER_PASS; i++) {
    const r = await execute(
      deps.registry,
      deps.adapter,
      SYSTEM_CTX,
      "change_journal.collect_garbage",
      {},
    );
    if (!r.ok) throw new Error(`change_journal.collect_garbage failed: ${JSON.stringify(r.error)}`);
    if (!(r.value as { more: boolean }).more) return i + 1;
  }
  return MAX_CALLS_PER_PASS;
}
