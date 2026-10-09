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
import { pendingSnapshotSql, releaseIdleDraftLocks } from "./draft.js";
import { lockedEntityLabel } from "./entity-labels.js";
import {
  acquireEntityLease,
  type LeaseHolder,
  releaseLeasesByBranch,
  releaseLeasesByHolder,
  siblingLeaseError,
} from "./entity-leases.js";
import {
  snapshotTablesForLockKind,
  type TakeoverOutcome,
  takeOverEntity,
} from "./lock-takeover.js";

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

/** A newer draft change by another chat that a write would overwrite. */
export interface StaleDraftChange {
  readonly chatTitle: string;
  /** ISO time of that change. */
  readonly changedAt: string;
}

export interface LockCheckResult {
  /** True iff the caller may write (it holds, acquired or took over the lock). */
  permitted: boolean;
  /**
   * Issue #620 — set when the caller took the entity over from another
   * chat: that chat's unstaged change on it now belongs to the caller.
   */
  takeover?: TakeoverOutcome;
  /**
   * Issue #620 — set when permitted=false because another chat changed the
   * entity in the shared draft after this chat last saw it (optimistic
   * versioning): the AI re-reads and redoes its edit.
   */
  staleDraft?: StaleDraftChange;
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
  // The writing chat on this branch: the caller's own chat (a subagent's
  // task counts as its parent chat — caelo_chat_owner) when the caller is
  // identified, else any chat on the branch. Issue #620 — on the shared
  // draft many chats share one branch, so the branch alone no longer names
  // the writer. No chat on the branch (deleted, never created) = system
  // write.
  const sessionRows = (await tx.execute(sql`
    SELECT caelo_chat_owner(cs.id)::text AS owner, cs.branch_kind,
           (cs.id = ${args.holderKey ?? null}::uuid) AS is_caller,
           (cs.parent_chat_session_id IS NOT NULL) AS is_subagent
    FROM chat_sessions cs
    WHERE cs.chat_branch_id = ${args.chatBranchId}::uuid
    ORDER BY (cs.id = ${args.holderKey ?? null}::uuid) DESC NULLS LAST, cs.created_at
    LIMIT 1
  `)) as unknown as {
    owner: string;
    branch_kind: string;
    is_caller: boolean | null;
    is_subagent: boolean;
  }[];
  const writer = sessionRows[0];
  if (!writer) {
    return { permitted: true };
  }
  const sessionId = writer.owner;
  const onDraft = writer.branch_kind === "draft";
  // Atomic upsert: INSERT-ON-CONFLICT-DO-NOTHING then read back. The
  // returned row tells us which branch holds the lock — caller's or other.
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
  // SIBLING task on this branch (same resolved chat, different `holderKey`)
  // can't clobber the entity. Taken BEFORE any takeover: a refused write
  // must not have moved another chat's change. Skipped when the writer
  // can't be identified (no holderKey), since siblings can only be told
  // apart by their own session id. Issue #620 — on the shared draft only
  // subagents lease: two draft chats are not siblings of one task set, and
  // a timed lease between them would be the time-based block the draft
  // replaces with optimistic versioning (below).
  if (args.holderKey && (!onDraft || (writer.is_caller === true && writer.is_subagent))) {
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
  if (row.chat_branch_id === args.chatBranchId) {
    if (onDraft && writer.is_caller === true) {
      const stale = await draftConflict(tx, args.kind, args.entityId, args.chatBranchId, sessionId);
      if (stale) return { permitted: false, staleDraft: stale };
    }
    return { permitted: true };
  }
  // issue #620 — another branch holds it: adopt that branch's unstaged
  // change instead of refusing.
  const takeover = await takeOverEntity(tx, {
    kind: args.kind,
    entityId: args.entityId,
    holder: { chatSessionId: row.chat_session_id, chatBranchId: row.chat_branch_id },
    taker: { chatSessionId: sessionId, chatBranchId: args.chatBranchId },
  });
  if (onDraft && writer.is_caller === true) {
    await observeDraftEntity(tx, sessionId, args.kind, args.entityId);
  }
  return { permitted: true, takeover };
}

/**
 * Issue #620 — optimistic per-entity versioning inside the shared draft.
 * Draft chats take no locks against each other; instead a write is a
 * conflict when ANOTHER chat changed the entity in the draft after this
 * chat last saw it (its own last write of the entity, or the last conflict
 * it was told about). Concurrent writers are serialized by the lock row
 * read `FOR UPDATE` above, so the check sees committed state.
 *
 * A conflict records the observation (the AI is now told about the change
 * and re-reads), so the retry with the fresh state passes. A permitted
 * write records it too.
 *
 * @returns the newer change by another chat, or null when the write may go.
 */
async function draftConflict(
  tx: TransactionRunner,
  kind: LockedEntityKind,
  entityId: string,
  branchId: string,
  chatSessionId: string,
): Promise<StaleDraftChange | null> {
  const tables = snapshotTablesForLockKind(kind);
  let stale: StaleDraftChange | null = null;
  if (tables.length > 0) {
    const newer = sql.join(
      tables.map(
        (t) => sql`
          SELECT ss.created_at, caelo_chat_owner(ss.chat_task_id) AS owner
          FROM ${sql.raw(t.table)} es JOIN site_snapshots ss ON ss.id = es.site_snapshot_id
          WHERE es.${sql.raw(t.column)} = ${entityId}::uuid
            AND ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}`,
      ),
      sql` UNION ALL `,
    );
    const rows = (await tx.execute(sql`
      WITH changes AS (${newer})
      SELECT to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
             COALESCE(cs.title, 'a change made outside a chat') AS title
      FROM changes c
      LEFT JOIN chat_sessions cs ON cs.id = c.owner
      WHERE c.owner IS DISTINCT FROM ${chatSessionId}::uuid
        AND c.created_at > COALESCE(
          (SELECT seen_at FROM draft_entity_observations
            WHERE chat_session_id = ${chatSessionId}::uuid
              AND entity_kind = ${kind} AND entity_id = ${entityId}::uuid),
          '-infinity'::timestamptz)
      ORDER BY c.created_at DESC
      LIMIT 1
    `)) as unknown as { at: string; title: string }[];
    const r = rows[0];
    if (r) stale = { chatTitle: r.title, changedAt: r.at };
  }
  await observeDraftEntity(tx, chatSessionId, kind, entityId);
  return stale;
}

/** Record that a draft chat has now seen the entity's current draft state. */
async function observeDraftEntity(
  tx: TransactionRunner,
  chatSessionId: string,
  kind: LockedEntityKind,
  entityId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO draft_entity_observations (chat_session_id, entity_kind, entity_id, seen_at)
    VALUES (${chatSessionId}::uuid, ${kind}, ${entityId}::uuid, now())
    ON CONFLICT (chat_session_id, entity_kind, entity_id) DO UPDATE SET seen_at = now()
  `);
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
  const rows = (await tx.execute(sql`
    SELECT chat_branch_id::text AS chat_branch_id, branch_kind
    FROM chat_sessions WHERE id = ${chatSessionId}::uuid
    LIMIT 1
  `)) as unknown as { chat_branch_id: string | null; branch_kind: string }[];
  const session = rows[0];
  if (session?.branch_kind === "draft" && session.chat_branch_id) {
    // Issue #620 — draft locks belong to the shared draft, not to the chat
    // that happened to write first: other draft chats may still have
    // pending changes on the same entities. Release only what the draft no
    // longer has pending, and only this chat's own sibling leases.
    await releaseIdleDraftLocks(tx, session.chat_branch_id);
    await releaseLeasesByHolder(tx, chatSessionId);
    return;
  }
  await tx.execute(sql`
    DELETE FROM chat_entity_locks
    WHERE chat_session_id = ${chatSessionId}::uuid
  `);
  if (session?.chat_branch_id) {
    await releaseLeasesByBranch(tx, session.chat_branch_id);
  }
}

/**
 * Build the structured error for a refused entity write: a `siblingLease`
 * conflict (issue #264 — a parallel task on the same branch holds the
 * entity) or a `staleDraft` conflict (issue #620 — another chat changed
 * the entity in the shared draft since this chat last saw it). Another
 * branch's lock is taken over instead of refused (see
 * {@link checkAndAcquireEntityLock}).
 *
 * Every op that guards a write with {@link checkAndAcquireEntityLock}
 * routes its `!permitted` case through this helper.
 */
export async function entityWriteBlockedError(
  tx: TransactionRunner,
  operation: string,
  kind: LockedEntityKind,
  entityId: string,
  result: LockCheckResult,
): Promise<
  | ReturnType<typeof siblingLeaseError>
  | { kind: "HandlerError"; operation: string; message: string }
> {
  if (result.siblingLease) {
    return siblingLeaseError(operation, kind, entityId, result.siblingLease);
  }
  if (result.staleDraft) {
    const label = await lockedEntityLabel(tx, kind, entityId);
    return {
      kind: "HandlerError",
      operation,
      message:
        `Conflict: ${kind} '${label}' was changed in the shared draft by chat '${result.staleDraft.chatTitle}' (${result.staleDraft.changedAt}) after this chat last looked at it, so this write was NOT applied. ` +
        "Read it again to get the current version, then redo your edit on top of it (do not resend the old content).",
    };
  }
  // Defensive: a refused write must carry its conflict. Fail loud
  // (CLAUDE.md §2 no silent fallbacks) rather than returning a vague error.
  throw new Error(
    `entityWriteBlockedError called for ${operation} on ${kind} ${entityId} without a conflict`,
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
  return (await entityWriteBlockedError(tx, args.operation, "pluginRow", args.rowId, result))
    .message;
};
