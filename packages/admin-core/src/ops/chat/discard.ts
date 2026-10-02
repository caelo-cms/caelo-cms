// SPDX-License-Identifier: MPL-2.0

/**
 * `chat.discard_branch` — undo a chat before it is published
 * (docs/branch-aware-plugin-storage.md §4, CMS_REQUIREMENTS §14.7).
 *
 * Nothing a chat wrote on its branch is live, so undoing it is dropping
 * the branch state, not reverting the site:
 *
 * - edits to main entities live only in branch snapshots; closing the
 *   chat makes them unreachable (the snapshots stay as history);
 * - rows the branch *created* already sit in the live tables, tagged
 *   with the branch (core `chat_branch_id`, plugin `caelo_chat_branch_id`)
 *   and invisible to main; they are soft-deleted and keep the tag;
 * - the chat's entity locks are released and the chat is closed
 *   (`discarded_at` + `archived_at`), so it can never be merged — a merge
 *   would resurrect what the discard dropped.
 *
 * Whatever the chat already staged is on main and stays there; that is
 * undone with the snapshot revert, like any other main-line change.
 */

import { discardBranchPluginRows } from "@caelo-cms/plugin-host";
import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { releaseChatLocks } from "../../locks.js";

/** Core tables whose rows can be created on a branch (migration 0089, 0093). */
const BRANCHED_CREATE_TABLES = ["pages", "modules", "templates", "layouts", "content_instances"];

export const discardChatBranchOp = defineOperation({
  name: "chat.discard_branch",
  // Why human-only: it throws away a chat's unpublished work and closes
  // the chat — the operator's decision, not something the AI does to its
  // own conversation.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    /** Branch-created rows soft-deleted, core and plugin. */
    droppedRows: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const sessions = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id, published_at, discarded_at
      FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      LIMIT 1
    `)) as unknown as {
      chat_branch_id: string;
      published_at: unknown;
      discarded_at: unknown;
    }[];
    const session = sessions[0];
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.discard_branch",
        message: "session not found",
      });
    }
    if (session.published_at !== null) {
      return err({
        kind: "HandlerError",
        operation: "chat.discard_branch",
        message:
          "chat already published — its changes are live; undo them with a snapshot revert instead",
      });
    }
    if (session.discarded_at !== null) return ok({ droppedRows: 0 });
    const branchId = session.chat_branch_id;

    let droppedRows = 0;
    for (const table of BRANCHED_CREATE_TABLES) {
      const rows = (await tx.execute(sql`
        UPDATE ${sql.raw(table)} SET deleted_at = now()
        WHERE chat_branch_id = ${branchId}::uuid AND deleted_at IS NULL
        RETURNING 1
      `)) as unknown as unknown[];
      droppedRows += rows.length;
    }
    droppedRows += await discardBranchPluginRows(tx, branchId);

    await releaseChatLocks(tx, input.chatSessionId);
    await tx.execute(sql`
      UPDATE chat_sessions
      SET discarded_at = now(), archived_at = COALESCE(archived_at, now())
      WHERE id = ${input.chatSessionId}::uuid
    `);
    await tx.execute(sql`
      INSERT INTO site_snapshots (actor_id, op_kind, description, chat_branch_id)
      VALUES (${ctx.actorId}::uuid, 'chat.discard_branch',
              ${`chat.discard_branch session=${input.chatSessionId} dropped=${droppedRows}`},
              ${branchId}::uuid)
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.discard_branch",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `dropped=${droppedRows}`,
    });
    return ok({ droppedRows });
  },
});
