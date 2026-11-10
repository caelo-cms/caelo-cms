// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — what the chat lifecycle does to pending redirect changes
 * (model.ts has the model). The live state is never touched here.
 *
 * - Undo of a draft chat removes that chat's pending changes: the manual
 *   ones, and the automatic ones its own unstaged page writes caused (a
 *   delete's dead-URL 301). Discarding a draft chat does the same.
 * - A Stage of draft chats settles their automatic changes: the page writes
 *   that caused them are staged now, so a later Undo of the chat (which
 *   only undoes unstaged work) must not take them away.
 * - An isolated branch (an experiment, a site migration) keeps its pending
 *   changes until its Stage merge moves them to the shared draft; a discard
 *   drops them.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** Remove a draft chat's pending changes (Undo, discard). @returns how many. */
export async function discardChatRedirectChanges(
  tx: TransactionRunner,
  chatSessionId: string,
): Promise<number> {
  const gone = (await tx.execute(sql`
    DELETE FROM pending_redirects WHERE chat_session_id = ${chatSessionId}::uuid RETURNING 1
  `)) as unknown as unknown[];
  return gone.length;
}

/** Remove an isolated branch's pending changes (its chat is discarded). @returns how many. */
export async function discardBranchRedirectChanges(
  tx: TransactionRunner,
  branchId: string,
): Promise<number> {
  const gone = (await tx.execute(sql`
    DELETE FROM pending_redirects WHERE chat_branch_id = ${branchId}::uuid RETURNING 1
  `)) as unknown as unknown[];
  return gone.length;
}

/**
 * An isolated branch's Stage merge: its pending changes join the shared
 * draft (main), so the staging view serves the Staged ones from now on.
 */
export async function mergeBranchRedirectChanges(
  tx: TransactionRunner,
  branchId: string,
): Promise<number> {
  const moved = (await tx.execute(sql`
    UPDATE pending_redirects SET chat_branch_id = NULL, updated_at = now()
    WHERE chat_branch_id = ${branchId}::uuid
    RETURNING 1
  `)) as unknown as unknown[];
  return moved.length;
}

/**
 * A Stage of draft chats finished: the automatic changes their page writes
 * caused before the merge (`stagedAt`) belong to the staged state now, no
 * longer to the chat's unstaged work an Undo removes.
 */
export async function settleStagedChatRedirectChanges(
  tx: TransactionRunner,
  chatSessionIds: readonly string[],
  stagedAt: string,
): Promise<void> {
  if (chatSessionIds.length === 0) return;
  await tx.execute(sql`
    UPDATE pending_redirects SET chat_session_id = NULL
    WHERE chat_session_id = ANY(${uuidArray([...chatSessionIds])})
      AND origin <> 'manual' AND created_at <= ${stagedAt}::timestamptz
  `);
}
