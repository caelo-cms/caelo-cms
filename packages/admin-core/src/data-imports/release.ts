// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: when imported rows reach visitors (kinds with release
 * `stage`, docs/data-imports.md).
 *
 *   draft    the import is written; editors see it, no environment does.
 *   merged   the Stage that ships its chat has merged it (or, without a
 *            chat, the next build takes it); the next build stamps it.
 *   staged   a build stamped it: environments whose release pointer names
 *            that run or a later one show it.
 *
 * An environment shows an import while `staged_since <= start of the run
 * its pointer names` and the undo, if any, is not stamped at or before that
 * start. A rollback moves the pointer back, which takes the imports of the
 * rolled-back release with it; nothing here needs to know about rollbacks.
 */

import { importShownSql } from "@caelo-cms/plugin-host";
import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";

/**
 * Deploy hook (deploy.start_trigger, both environments): stamp every import
 * the build carries with the run. That is every merged import, and every
 * import made outside a chat, not stamped yet; and likewise their undos.
 * Runs in the transaction that creates the run, so the build reads exactly
 * the imports stamped here.
 */
export async function stampImportsForRun(tx: TransactionRunner, runId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE data_imports di
    SET merged_at = COALESCE(di.merged_at, now()),
        staged_run_id = r.id, staged_since = r.started_at, updated_at = now()
    FROM deploy_runs r
    WHERE r.id = ${runId}::uuid
      AND di.release = 'stage' AND di.staged_since IS NULL AND di.undone_at IS NULL
      AND (di.merged_at IS NOT NULL OR di.chat_session_id IS NULL)
  `);
  await tx.execute(sql`
    UPDATE data_imports di
    SET undo_merged_at = COALESCE(di.undo_merged_at, now()),
        undo_staged_run_id = r.id, undo_staged_since = r.started_at, updated_at = now()
    FROM deploy_runs r
    WHERE r.id = ${runId}::uuid
      AND di.release = 'stage' AND di.undo_staged_since IS NULL AND di.undone_at IS NOT NULL
      AND di.staged_since IS NOT NULL
      AND (di.undo_merged_at IS NOT NULL OR di.undo_chat_session_id IS NULL)
  `);
}

/**
 * Stage hook (chat.merge_draft_to_main, chat.merge_to_main): the chats'
 * imports and undos are part of what this Stage ships.
 */
export async function mergeChatImports(
  tx: TransactionRunner,
  chatSessionIds: readonly string[],
): Promise<void> {
  if (chatSessionIds.length === 0) return;
  await tx.execute(sql`
    UPDATE data_imports SET merged_at = now(), updated_at = now()
    WHERE chat_session_id = ANY(${uuidArray(chatSessionIds)})
      AND release = 'stage' AND merged_at IS NULL AND undone_at IS NULL
  `);
  await tx.execute(sql`
    UPDATE data_imports SET undo_merged_at = now(), updated_at = now()
    WHERE undo_chat_session_id = ANY(${uuidArray(chatSessionIds)})
      AND release = 'stage' AND undo_merged_at IS NULL AND undone_at IS NOT NULL
      AND staged_since IS NOT NULL
  `);
}

/**
 * Where an import stands, as one SQL `CASE` over the row aliased `di`:
 * draft | waiting-for-build | staged | live | undo-pending | undone,
 * written for kinds with release `target` (redirects follow their own
 * drafts), and removal-pending for an undo whose removal did not finish.
 */
export function importStateSql(): SQL {
  return sql`CASE
    WHEN di.removal_pending THEN 'removal-pending'
    WHEN di.release = 'target' THEN CASE WHEN di.undone_at IS NULL THEN 'written' ELSE 'undone' END
    WHEN di.undone_at IS NOT NULL AND di.staged_since IS NULL THEN 'undone'
    WHEN di.undone_at IS NOT NULL THEN
      CASE WHEN ${importShownSql("live")} OR ${importShownSql("staging")} THEN 'undo-pending'
           ELSE 'undone' END
    WHEN ${importShownSql("live")} THEN 'live'
    WHEN ${importShownSql("staging")} THEN 'staged'
    WHEN di.staged_since IS NOT NULL OR di.merged_at IS NOT NULL THEN 'waiting-for-build'
    ELSE 'draft' END`;
}

/**
 * SQL predicate: the chat under `csAlias` has an import or an undo that
 * waits for its Stage. Open changes list such a chat, and "Stage all my
 * chats" stages it, like a chat with unstaged edits.
 */
export function chatHasPendingImportsSql(csAlias = "cs"): SQL {
  const cs = sql.raw(csAlias);
  return sql`(EXISTS (SELECT 1 FROM data_imports di
                      WHERE di.chat_session_id = ${cs}.id AND di.release = 'stage'
                        AND di.merged_at IS NULL AND di.undone_at IS NULL)
          OR EXISTS (SELECT 1 FROM data_imports di
                      WHERE di.undo_chat_session_id = ${cs}.id AND di.release = 'stage'
                        AND di.undo_merged_at IS NULL AND di.staged_since IS NOT NULL))`;
}

/** How many imports and undos wait for each chat's Stage. */
export async function pendingImportCounts(
  tx: TransactionRunner,
  chatSessionIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (chatSessionIds.length === 0) return out;
  const rows = (await tx.execute(sql`
    SELECT chat::text AS chat, count(*)::int AS n FROM (
      SELECT chat_session_id AS chat FROM data_imports
      WHERE chat_session_id = ANY(${uuidArray(chatSessionIds)}) AND release = 'stage'
        AND merged_at IS NULL AND undone_at IS NULL
      UNION ALL
      SELECT undo_chat_session_id FROM data_imports
      WHERE undo_chat_session_id = ANY(${uuidArray(chatSessionIds)}) AND release = 'stage'
        AND undo_merged_at IS NULL AND staged_since IS NOT NULL
    ) w GROUP BY chat
  `)) as unknown as { chat: string; n: number }[];
  for (const r of rows) out.set(r.chat, r.n);
  return out;
}
