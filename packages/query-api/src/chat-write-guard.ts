// SPDX-License-Identifier: MPL-2.0

/**
 * #1102 — refuse an authoring write tagged with a chat that was archived or
 * discarded. Such a chat may own no pending change (chat.archive_session
 * refuses while it has one; a discard undoes them): a write into it left a
 * change in the shared draft that no chat lists, stages or undoes, while
 * the editor said "Saved." and Live Edit, which never resumes a closed
 * chat, showed another chat's state.
 *
 * Every writer of a `site_snapshots` header with a `chat_task_id` calls it
 * before the insert: admin-core's emitSnapshot, the plugin row snapshots
 * (plugin-host) and the lock takeover. `FOR SHARE` serialises with the
 * archive/discard of the same chat, which lock the row `FOR UPDATE` before
 * checking for pending changes. It throws {@link OperationAbortError}, so
 * the whole operation rolls back and the caller gets an actionable
 * HandlerError.
 */

import { sql } from "drizzle-orm";
import { OperationAbortError } from "./errors.js";
import type { TransactionRunner } from "./operation.js";

/**
 * Throw when `chatTaskId` (a chat session, or a subagent task mapped to its
 * parent by `caelo_chat_owner`) belongs to an archived or discarded chat.
 *
 * @param operation - names the write in the error (op or snapshot kind)
 */
export async function assertChatOpenForWrite(
  tx: TransactionRunner,
  chatTaskId: string,
  operation: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT archived_at IS NOT NULL AS archived, discarded_at IS NOT NULL AS discarded
    FROM chat_sessions WHERE id = caelo_chat_owner(${chatTaskId}::uuid)
    FOR SHARE
  `)) as unknown as { archived: boolean; discarded: boolean }[];
  const chat = rows[0];
  if (!chat || (!chat.archived && !chat.discarded)) return;
  throw new OperationAbortError({
    kind: "HandlerError",
    operation,
    message: `this chat was ${chat.discarded ? "discarded" : "archived"}, so the change was not saved. Continue in an open chat: reload Live Edit (or pick or start a chat in the chat list) and make the change there.`,
  });
}
