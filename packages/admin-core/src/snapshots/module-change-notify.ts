// SPDX-License-Identifier: MPL-2.0

/**
 * #1214 — after a write that changed modules commits, tell the plugins
 * that keep a per-module verdict (plugin-host `notifyModuleChanges`).
 *
 * Hooked into the snapshot emitter because every write emits a snapshot
 * (CLAUDE.md §2): module edits, content-instance values, deletes,
 * reverts, merges and imports all pass through it, so no write path can
 * forget to notify. The snapshot's entity states say which modules a
 * write touched; a content instance's state names its module.
 *
 * Coalesced per transaction and scope: an op that emits ten snapshots
 * makes one plugin call per contributor, after the commit, with no
 * pooled connection held (epic #1209).
 */

import { moduleChangeContributors, notifyModuleChanges } from "@caelo-cms/plugin-host";
import { afterCommit, type TransactionRunner } from "@caelo-cms/query-api";
import type { SnapshotEntity } from "./emit.js";

interface PendingNotice {
  readonly actorId: string;
  readonly chatBranchId: string | null;
  readonly moduleIds: Set<string>;
}

/** Notices per transaction, keyed by write scope (branch + actor). */
const pendingByTx = new WeakMap<TransactionRunner, Map<string, PendingNotice>>();

/** The modules whose rendered content an entity's new state may change. */
export function touchedModuleIds(entities: ReadonlyArray<SnapshotEntity>): string[] {
  const ids = new Set<string>();
  for (const e of entities) {
    if (e.kind === "module") ids.add(e.entityId);
    else if (e.kind === "contentInstance") ids.add(e.state.moduleId);
  }
  return [...ids];
}

/**
 * Queue a module-change notice for after `tx` commits. A no-op while no
 * active plugin declares a `moduleChangesOperation`, so a site without
 * one pays nothing.
 */
export function queueModuleChangeNotice(
  tx: TransactionRunner,
  scope: { actorId: string; chatBranchId: string | null },
  entities: ReadonlyArray<SnapshotEntity>,
): void {
  const moduleIds = touchedModuleIds(entities);
  if (moduleIds.length === 0 || moduleChangeContributors().length === 0) return;
  let byScope = pendingByTx.get(tx);
  if (!byScope) {
    byScope = new Map();
    pendingByTx.set(tx, byScope);
  }
  const key = `${scope.chatBranchId ?? ""}|${scope.actorId}`;
  const existing = byScope.get(key);
  if (existing) {
    for (const id of moduleIds) existing.moduleIds.add(id);
    return;
  }
  const notice: PendingNotice = { ...scope, moduleIds: new Set(moduleIds) };
  byScope.set(key, notice);
  afterCommit(tx, {
    label: `tell plugins that ${moduleIds.length > 1 ? "modules" : "a module"} changed`,
    run: async () => {
      const failures = await notifyModuleChanges([...notice.moduleIds], notice);
      // Each throw is already in the plugin's error log (#1008). The
      // write itself committed and stays good, so it is not failed here:
      // the stale verdict is the plugin's to repair, and its scheduled
      // rescan does.
      for (const f of failures) {
        console.warn(
          `[admin-core] plugin "${f.slug}" was not told about ${notice.moduleIds.size} changed module(s): ${f.message}`,
        );
      }
    },
  });
}
