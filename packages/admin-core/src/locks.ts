// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.0 — Per-entity write locks for global entities.
 *
 * When a chat writes to a module / template / layout / structured_set /
 * redirect, the entity is locked to that chat's session until the chat
 * stages, publishes or is discarded. The lock keeps two branches from
 * holding divergent unmerged edits of the same entity — merge is "latest
 * state wins", so the second Stage would silently overwrite the first.
 *
 * Issue #620 — a lock no longer BLOCKS another chat. When chat B writes
 * an entity chat A holds, B takes it over: A's unstaged change on that
 * entity moves to B's branch and the lock moves with it
 * (`lock-takeover.ts`), and B's write builds on the adopted state. Both
 * chats are told on their next tool result. There is no time-based
 * expiry — an expired lock over unstaged changes is exactly the silent
 * overwrite the lock exists to prevent.
 *
 * Page-bound entities (`pages`, `page_modules`, `page_module_content`)
 * lock under the `page` kind.
 *
 * System writes (`ctx.chatBranchId === null/undefined`) bypass locks.
 * Locks are released on `chat.publish`, `chat.merge_to_main` (Stage —
 * v0.10.19), or chat discard / archive.
 */

import type { PluginRowLocker } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  acquireEntityLease,
  type LeaseHolder,
  releaseLeasesByBranch,
  siblingLeaseError,
} from "./entity-leases.js";
import { type TakeoverOutcome, takeOverEntity } from "./lock-takeover.js";

export type LockedEntityKind =
  | "module"
  | "template"
  | "pageLayout"
  | "layout"
  | "structuredSet"
  | "redirect"
  // v0.5.3 — page-bound writes (pages.update / pages.delete /
  // pages.set_modules etc.) and global config singletons
  // (site_settings / site_defaults) gain locks to close the v0.5
  // coverage gap.
  | "page"
  | "siteSettings"
  | "siteDefaults"
  // v0.12.0 — content_instances.set_values on a synced placement
  // propagates to every page that references the instance, so the lock
  // is per-instance (not per-placement) so two chats can't simultaneously
  // rewrite shared content.
  | "contentInstance"
  // v0.11.0 — themes are global (one active row affects every page),
  // so writes lock the theme entity same as structured_sets / layouts.
  | "theme"
  // A row in a plugin's private storage written on a chat branch
  // (docs/branch-aware-plugin-storage.md). Row ids are uuids, unique
  // across plugin tables, so the row id alone keys the lock.
  | "pluginRow";

export interface LockCheckResult {
  /** True iff the caller may write (it holds, acquired or took over the lock). */
  permitted: boolean;
  /**
   * Issue #620 — set when the caller took the entity over from another
   * chat: that chat's unstaged change on it now belongs to the caller.
   */
  takeover?: TakeoverOutcome;
  /**
   * issue #264 — set when permitted=false because a SIBLING TASK on the
   * SAME branch already holds the per-entity sub-lease — a disjointness
   * violation between parallel subagents, surfaced via
   * {@link siblingLeaseError}. Since #620 the only way a write is refused:
   * another chat's lock is taken over, never a refusal.
   */
  siblingLease?: LeaseHolder;
}

/**
 * Check whether the caller's chat may write to (entityKind, entityId),
 * acquiring or taking over the lock.
 *
 * - System writes (no chatBranchId on ctx) always permitted.
 * - Caller already holds the lock → permitted.
 * - Entity unlocked → permitted; CALLER acquires it.
 * - Held by another chat → the caller TAKES IT OVER (issue #620): the
 *   holder's unstaged change on the entity moves to the caller's branch,
 *   the lock moves with it, and `result.takeover` says what was adopted.
 *
 * Caller supplies `chatBranchId`; this helper resolves the session id
 * from `chat_sessions` so callers don't have to thread it through every
 * op handler. Lock rows reference chat_session_id directly so
 * `ON DELETE CASCADE` from a chat-session delete tears down locks. The
 * lock row is read `FOR UPDATE`, so two chats racing for one entity are
 * serialized and the second one adopts the first one's committed change.
 *
 * issue #264 — the branch lock alone lets parallel sibling subagents (all
 * on the parent's branch) write the same entity, since they resolve to
 * one session. When `holderKey` (the caller's OWN session, `ctx.chatTaskId`)
 * is supplied, this ALSO takes a per-entity sub-lease so a sibling with a
 * different holder is refused via `result.siblingLease`. Omitting
 * `holderKey` (non-chat / unidentifiable writer) skips the sub-lease and
 * falls back to branch-lock-only behaviour.
 */
export async function checkAndAcquireEntityLock(
  tx: TransactionRunner,
  args: {
    kind: LockedEntityKind;
    entityId: string;
    chatBranchId: string | null | undefined;
    /** The caller's own session id (`ctx.chatTaskId`) — the lease holder. */
    holderKey?: string | null;
    /** Injected clock + TTL for deterministic tests; defaults otherwise. */
    now?: Date;
    ttlMs?: number;
  },
): Promise<LockCheckResult> {
  if (!args.chatBranchId) {
    return { permitted: true };
  }
  // Resolve sessionId from branchId (1:1). If the branch isn't tied to
  // a session row (deleted, never created), treat as system-write.
  const sessionRows = (await tx.execute(sql`
    SELECT id::text AS id FROM chat_sessions
    WHERE chat_branch_id = ${args.chatBranchId}::uuid
    LIMIT 1
  `)) as unknown as { id: string }[];
  const sessionId = sessionRows[0]?.id;
  if (!sessionId) {
    return { permitted: true };
  }
  // Atomic upsert: INSERT-ON-CONFLICT-DO-NOTHING then read back. The
  // returned row tells us who holds the lock — caller or other.
  await tx.execute(sql`
    INSERT INTO chat_entity_locks (entity_kind, entity_id, chat_session_id, chat_branch_id)
    VALUES (${args.kind}, ${args.entityId}::uuid, ${sessionId}::uuid, ${args.chatBranchId}::uuid)
    ON CONFLICT (entity_kind, entity_id) DO NOTHING
  `);
  const rows = (await tx.execute(sql`
    SELECT chat_session_id::text AS chat_session_id,
           chat_branch_id::text AS chat_branch_id,
           locked_at
    FROM chat_entity_locks
    WHERE entity_kind = ${args.kind} AND entity_id = ${args.entityId}::uuid
    LIMIT 1
    FOR UPDATE
  `)) as unknown as { chat_session_id: string; chat_branch_id: string; locked_at: string | Date }[];
  const row = rows[0];
  if (!row) {
    return { permitted: true };
  }
  // issue #264 — the per-entity sub-lease on the caller's own branch, so a
  // SIBLING task on this branch (same resolved session, different
  // `holderKey`) can't clobber the entity. Taken BEFORE any takeover: a
  // refused write must not have moved another chat's change. Skipped when
  // the writer can't be identified (no holderKey), since siblings can
  // only be told apart by their own session id.
  if (args.holderKey) {
    const lease = await acquireEntityLease(tx, {
      kind: args.kind,
      entityId: args.entityId,
      branchId: args.chatBranchId,
      holderKey: args.holderKey,
      now: args.now,
      ttlMs: args.ttlMs,
    });
    if (!lease.acquired && lease.holder) {
      return { permitted: false, siblingLease: lease.holder };
    }
  }
  if (row.chat_session_id === sessionId) {
    return { permitted: true };
  }
  // issue #620 — adopt the holder's unstaged change instead of refusing.
  const takeover = await takeOverEntity(tx, {
    kind: args.kind,
    entityId: args.entityId,
    holder: { chatSessionId: row.chat_session_id, chatBranchId: row.chat_branch_id },
    taker: { chatSessionId: sessionId, chatBranchId: args.chatBranchId },
  });
  return { permitted: true, takeover };
}

/**
 * Release all locks held by a chat. Called by chat.publish on success
 * and by chat discard / archive paths.
 *
 * issue #264 — also clears every per-entity sub-lease on the chat's
 * branch. Once a chat publishes or is discarded the branch is gone, so
 * any residual leases (including an orphaned subagent's that never hit
 * `subagent_runs.finish`) are dead weight; dropping them by branch keeps
 * the entity_leases table free of tombstones referencing merged branches.
 */
export async function releaseChatLocks(
  tx: TransactionRunner,
  chatSessionId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM chat_entity_locks
    WHERE chat_session_id = ${chatSessionId}::uuid
  `);
  const rows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS chat_branch_id
    FROM chat_sessions WHERE id = ${chatSessionId}::uuid
    LIMIT 1
  `)) as unknown as { chat_branch_id: string | null }[];
  const branchId = rows[0]?.chat_branch_id;
  if (branchId) {
    await releaseLeasesByBranch(tx, branchId);
  }
}

/**
 * Build the structured error for a refused entity write. Since #620 the
 * only refusal is a `siblingLease` conflict (issue #264 — a parallel task
 * on the same branch holds the entity); another chat's lock is taken over
 * instead (see {@link checkAndAcquireEntityLock}).
 *
 * Every op that guards a write with {@link checkAndAcquireEntityLock}
 * routes its `!permitted` case through this helper. Precondition:
 * `result.permitted === false` with `siblingLease` set.
 */
export async function entityWriteBlockedError(
  _tx: TransactionRunner,
  operation: string,
  kind: LockedEntityKind,
  entityId: string,
  result: LockCheckResult,
): Promise<ReturnType<typeof siblingLeaseError>> {
  if (result.siblingLease) {
    return siblingLeaseError(operation, kind, entityId, result.siblingLease);
  }
  // Defensive: a refused write must carry its conflict. Fail loud
  // (CLAUDE.md §2 no silent fallbacks) rather than returning a vague error.
  throw new Error(
    `entityWriteBlockedError called for ${operation} on ${kind} ${entityId} without a siblingLease conflict`,
  );
}

/**
 * The `pluginRow` lock taker the plugin host calls for every branch write
 * to a plugin's private storage (PluginHostInfra.lockPluginRow).
 *
 * Same branch lock + per-task sub-lease as core entities — including the
 * #620 takeover of another chat's unstaged change on the row.
 */
export const lockPluginRow: PluginRowLocker = async (tx, args) => {
  const result = await checkAndAcquireEntityLock(tx, {
    kind: "pluginRow",
    entityId: args.rowId,
    chatBranchId: args.chatBranchId,
    holderKey: args.chatTaskId,
  });
  if (result.permitted) return null;
  if (!result.siblingLease) {
    throw new Error(`lockPluginRow: ${args.operation} refused on ${args.rowId} without a conflict`);
  }
  return siblingLeaseError(args.operation, "pluginRow", args.rowId, result.siblingLease).message;
};
