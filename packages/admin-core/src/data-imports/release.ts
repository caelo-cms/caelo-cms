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
 * draft | waiting-for-build | staged | live | undo-pending | undone, and
 * written for kinds with release `target` (redirects follow their own
 * drafts).
 */
export function importStateSql(): SQL {
  return sql`CASE
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
