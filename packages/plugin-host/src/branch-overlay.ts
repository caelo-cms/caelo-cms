// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1669 — a branch's pending rows of one plugin table, carried by the
 * change journal between reads.
 *
 * A `list` on a chat branch overlays every pending row of the table onto
 * the main-line rows (private-storage.ts), so it read all of them from the
 * draft head on every call: 271 rows per call on average in a two-minute
 * local gate run, 26.5 million in all, and more with every variant the
 * agents created, because each one adds pending rows to the shared draft
 * that every later read of the table pays for. The pending rows of a table
 * change only through the journal, so they are a cached read like the
 * site view (`docs/dev/state-and-changes.md`): one journal check per read
 * proves the remembered rows still exact, and only a change re-reads them.
 *
 * What changes them, and the filter therefore asks for:
 *
 * - a pending row of the table on the branch (`plugin_row`, an insert of
 *   its snapshot, or a delete when a discard drops it);
 * - a Stage, an undo or a lock takeover: an update or delete of a snapshot
 *   header, wherever it is (a takeover moves a header off the branch).
 *
 * The rows are the same for every reader of the table on the branch: a
 * `list` reads with the plugin's own id (`plugin_row_snapshots` RLS), and
 * the draft head is readable by every actor. A read that saw its own
 * transaction's uncommitted writes is never kept, since a rollback would
 * undo them without a journal row (`JournalMark.dirty`).
 */

import {
  checkJournalMark,
  type JournalFilter,
  type JournalMark,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { loadBranchRowStates, type PluginRowState } from "./row-snapshots.js";

/** The journal rows that change a table's pending rows on `chatBranchId`. */
export function branchOverlayJournalFilter(input: {
  readonly pluginId: string;
  readonly table: string;
  readonly chatBranchId: string;
}): JournalFilter {
  return {
    kinds: ["plugin_row", "snapshot"],
    branchId: input.chatBranchId,
    pluginIds: [input.pluginId],
    pluginTables: [input.table],
    kindOps: { snapshot: ["update", "delete", "truncate"] },
    unscopedOps: ["update", "delete", "truncate"],
    branchOnlyKinds: ["plugin_row"],
  };
}

interface CachedOverlay {
  readonly mark: JournalMark;
  readonly states: ReadonlyMap<string, PluginRowState>;
}

/**
 * Overlays per (branch, plugin, table), most recently used last. Bounded:
 * the tables being edited right now are few, and each entry holds only
 * that table's pending rows on one branch.
 */
const cache = new Map<string, CachedOverlay>();
const MAX_CACHED_OVERLAYS = 64;

/** How many overlays this process read from the draft head (test seam). */
let overlayReads = 0;

/**
 * The latest pending state of every row of `table` on `chatBranchId`, as
 * `tx` sees it: from memory when no journaled change reached it since it
 * was read, else read now and kept. Callers must not change the map.
 */
export async function loadBranchOverlay(
  tx: TransactionRunner,
  input: { readonly pluginId: string; readonly table: string; readonly chatBranchId: string },
): Promise<ReadonlyMap<string, PluginRowState>> {
  const key = `${input.chatBranchId}|${input.pluginId}|${input.table}`;
  const hit = cache.get(key);
  // One statement, hit or miss: the check, and the mark of the read below
  // (taken before it, so a change committing during the read is unseen by
  // the mark and invalidates once).
  const { fresh, mark } = await checkJournalMark(
    tx,
    hit?.mark ?? null,
    branchOverlayJournalFilter(input),
  );
  if (hit && fresh) {
    // Exact now, so keep the newer mark: the next check then costs what
    // was written since this one, not everything since the rows were read.
    if (!mark.dirty) remember(key, { mark, states: hit.states });
    return hit.states;
  }
  overlayReads += 1;
  const states = await loadBranchRowStates(tx, input);
  if (!mark.dirty) remember(key, { mark, states });
  return states;
}

function remember(key: string, entry: CachedOverlay): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_OVERLAYS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam: forget every remembered overlay. */
export function clearBranchOverlayCache(): void {
  cache.clear();
}

/** Test seam: how many overlays were read from the draft head so far. */
export function branchOverlayReadCount(): number {
  return overlayReads;
}
