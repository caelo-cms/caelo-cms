// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.0 — Per-entity write locks for global entities.
 *
 * When a chat writes to a module / template / layout / structured_set /
 * redirect, the entity is locked to that chat's session until the chat
 * publishes or is discarded. Other chats' writes are rejected with a
 * structured `{ kind: "Locked", holder: <chatSessionId> }` so the AI
 * can surface "module 'hero' is being edited in chat 'X' — pick a
 * different target or ask the operator to publish that chat first".
 *
 * Page-bound entities (`pages`, `page_modules`, `page_module_content`)
 * are NOT locked here — they're protected by the per-page-chat gate
 * (one chat per page), which is enforced at chat-session-create time.
 *
 * System writes (`ctx.chatBranchId === null/undefined`) bypass locks.
 * Locks are released on `chat.publish`, `chat.merge_to_main` (Stage —
 * v0.10.19), or chat discard / archive.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

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
  | "theme";

export interface LockHolder {
  chatSessionId: string;
  chatBranchId: string;
  lockedAt: string;
}

export interface LockCheckResult {
  /** True iff caller holds the lock OR the entity is unlocked. */
  permitted: boolean;
  /** Set when permitted=false; holder info for the error message. */
  holder?: LockHolder;
}

/**
 * Check whether the caller's chat may write to (entityKind, entityId).
 *
 * - System writes (no chatBranchId on ctx) always permitted.
 * - Caller already holds the lock → permitted.
 * - Entity unlocked → permitted; CALLER acquires it.
 * - Held by another chat → not permitted; returns holder info.
 *
 * Caller supplies `chatBranchId`; this helper resolves the session id
 * from `chat_sessions` so callers don't have to thread it through every
 * op handler. Lock rows reference chat_session_id directly so
 * `ON DELETE CASCADE` from a chat-session delete tears down locks.
 */
export async function checkAndAcquireEntityLock(
  tx: TransactionRunner,
  args: {
    kind: LockedEntityKind;
    entityId: string;
    chatBranchId: string | null | undefined;
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
  `)) as unknown as { chat_session_id: string; chat_branch_id: string; locked_at: string | Date }[];
  const row = rows[0];
  if (!row) {
    return { permitted: true };
  }
  if (row.chat_session_id === sessionId) {
    return { permitted: true };
  }
  const lockedAt =
    row.locked_at instanceof Date ? row.locked_at.toISOString() : String(row.locked_at);
  return {
    permitted: false,
    holder: {
      chatSessionId: row.chat_session_id,
      chatBranchId: row.chat_branch_id,
      lockedAt,
    },
  };
}

/**
 * Release all locks held by a chat. Called by chat.publish on success
 * and by chat discard / archive paths.
 */
export async function releaseChatLocks(
  tx: TransactionRunner,
  chatSessionId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM chat_entity_locks
    WHERE chat_session_id = ${chatSessionId}::uuid
  `);
}

/**
 * Build a structured error payload for a Locked rejection. The op
 * `err()` helper accepts a free-form shape; this returns the canonical
 * one so every locked-write returns the same error so the AI can
 * react uniformly.
 *
 * v0.8.0 — async + tx-aware. The helper does one extra read to look up
 * the holder chat's title + anchor page (slug + locale) so the message
 * names the *other chat the operator already knows about* instead of
 * a raw session UUID. The AI then surfaces something like:
 *   "module 'hero' is busy in another chat ('Build the docs site')
 *   on /home — finish that chat or pick a different target"
 * which the operator can act on without going to /security/locks.
 *
 * Failures during the enrich-read (deleted chat row, RLS surprise)
 * fall back to the v0.5.x UUID wording so the original Locked error
 * still surfaces. The lock check itself isn't affected.
 */
export async function lockedError(
  tx: TransactionRunner,
  operation: string,
  kind: LockedEntityKind,
  entityId: string,
  holder: LockHolder,
): Promise<{
  kind: "Locked";
  operation: string;
  message: string;
  entityKind: LockedEntityKind;
  entityId: string;
  holder: LockHolder & {
    title?: string;
    anchorPageSlug?: string;
    anchorPageLocale?: string;
  };
}> {
  let title: string | undefined;
  let anchorPageSlug: string | undefined;
  let anchorPageLocale: string | undefined;
  try {
    const rows = (await tx.execute(sql`
      SELECT cs.title,
             p.slug   AS page_slug,
             p.locale AS page_locale
      FROM chat_sessions cs
      LEFT JOIN pages p ON p.id = cs.page_id AND p.deleted_at IS NULL
      WHERE cs.id = ${holder.chatSessionId}::uuid
      LIMIT 1
    `)) as unknown as {
      title: string | null;
      page_slug: string | null;
      page_locale: string | null;
    }[];
    const r = rows[0];
    if (r) {
      if (typeof r.title === "string") title = r.title;
      if (typeof r.page_slug === "string") anchorPageSlug = r.page_slug;
      if (typeof r.page_locale === "string") anchorPageLocale = r.page_locale;
    }
  } catch {
    // Enrich-read failed — keep the structural error, fall through to
    // the UUID-only message below.
  }

  const titlePart = title ? ` ('${title}')` : "";
  const pagePart = anchorPageSlug ? ` on /${anchorPageSlug}` : "";
  const message = title
    ? `${kind} ${entityId} is busy in another chat${titlePart}${pagePart} — finish that chat (Stage + Publish) or pick a different target`
    : `${kind} ${entityId} is being edited in another chat (session ${holder.chatSessionId}); wait for that chat to publish or pick a different target`;

  return {
    kind: "Locked",
    operation,
    message,
    entityKind: kind,
    entityId,
    holder: {
      ...holder,
      ...(title !== undefined ? { title } : {}),
      ...(anchorPageSlug !== undefined ? { anchorPageSlug } : {}),
      ...(anchorPageLocale !== undefined ? { anchorPageLocale } : {}),
    },
  };
}
