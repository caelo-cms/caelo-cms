// SPDX-License-Identifier: MPL-2.0

/**
 * issue #262 — `# Locks held by other chats` system-prompt context block.
 *
 * Feeds `chat.list_foreign_locks` into the chat runner so the AI knows —
 * BEFORE it plans any work — which entities (theme, layout-bound chrome
 * modules, pages, ...) are locked by other chat sessions. Run #7's
 * migration only found out mid-run, one bounced `Locked` write at a
 * time. With the block present, the AI warns the operator in the plan
 * step ("another chat holds the theme — Stage/Publish or discard it
 * first") instead of dying halfway.
 *
 * Renders only when at least one foreign lock exists (CLAUDE.md §11:
 * context blocks are omitted when empty) and caps at 15 rows to stay
 * well under the 2 KB budget. Best-effort: a failed op omits the block,
 * never blocks the turn — same posture as the sibling domain builders.
 *
 * Interim guard until task leases replace chat locks (epic #264).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

import type { ForeignLock } from "../../../ops/chat/foreign-locks.js";

const MAX_ROWS = 15;

/**
 * Pure formatter — exported separately so the block's shape is unit-
 * testable without a database. Returns undefined for an empty list.
 */
export function formatForeignLocksBlock(locks: readonly ForeignLock[]): string | undefined {
  if (locks.length === 0) return undefined;
  const shown = locks.slice(0, MAX_ROWS);
  const lines = shown.map((l) => {
    const page = l.holder.pageSlug ? ` on /${l.holder.pageSlug}` : "";
    const pending =
      l.holder.pendingChangeCount > 0
        ? `${l.holder.pendingChangeCount} unshipped edit${l.holder.pendingChangeCount === 1 ? "" : "s"}`
        : "no unshipped edits — stale lock";
    return `- ${l.entityKind} "${l.label}" — held by chat "${l.holder.title}"${page} (${pending})`;
  });
  const overflow =
    locks.length > MAX_ROWS ? [`(… ${locks.length - MAX_ROWS} more foreign locks not shown.)`] : [];
  return [
    "# Locks held by other chats",
    "The entities below are locked by OTHER chat sessions; any write to them from THIS chat will fail with a Locked error. Check this list while planning — if the operator's request (site migration, theme/chrome rebuild, edits to a listed page) touches one of these, warn them UP FRONT: name the holding chat and tell them to Stage/Publish or discard it first. Do not start multi-step work that will collide with a listed lock.",
    ...lines,
    ...overflow,
  ].join("\n");
}

/**
 * Fetch + format. `chatSessionId` is the CURRENT chat — its own locks
 * are excluded (holding your own lock is normal, not a conflict).
 */
export async function buildForeignLocksBlock(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  chatSessionId: string,
): Promise<string | undefined> {
  const r = await execute(registry, adapter, humanCtx, "chat.list_foreign_locks", {
    chatSessionId,
  });
  if (!r.ok) return undefined;
  const { locks } = r.value as { locks: ForeignLock[] };
  return formatForeignLocksBlock(locks);
}
