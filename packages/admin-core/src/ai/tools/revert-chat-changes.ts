// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W4 (deferred) — `revert_chat_changes` composite tool.
 *
 * Undoes every snapshot tagged with one chat's branch_id by filing a
 * single `snapshots.propose_revert_site` proposal targeting the
 * snapshot RIGHT BEFORE the chat's first edit. The operator approves
 * one proposal instead of N per-entity reverts.
 *
 * The mechanics:
 *   1. Look up the chat's branch_id from chat_sessions.
 *   2. List snapshots tagged with that branch_id (oldest first).
 *   3. Find the immediately-prior snapshot on the timeline (the one
 *      with the largest created_at strictly less than the chat's
 *      first snapshot's created_at and NOT itself tagged with the
 *      same chat_branch_id).
 *   4. File `snapshots.propose_revert_site` against that pre-chat
 *      snapshot. Approving rewinds the whole site to that state.
 *
 * Limitations (surfaced loudly to the operator):
 *   - This rewinds the FULL SITE, not just the chat's entities. Any
 *     non-chat edit made between the chat and now ALSO reverts.
 *   - When the chat is the very first activity on the site (no
 *     pre-chat snapshot exists), the tool refuses with a clean
 *     message rather than reverting to an empty-DB state.
 *   - When the chat is unpublished (snapshots tagged with branch_id
 *     but no `merged_at` marker on main), discarding the chat is
 *     cheaper than reverting — the tool detects this and suggests
 *     chat discard instead.
 */

import { execute } from "@caelo-cms/query-api";
import { revertChatChangesToolInput } from "@caelo-cms/shared";
import { SQL } from "bun";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface SnapshotRow {
  id: string;
  createdAt: string;
  chatBranchId: string | null;
  moduleCount: number;
  templateCount: number;
  pageCount: number;
  pageLayoutCount: number;
}

export const revertChatChangesTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").RevertChatChangesToolInput
> = {
  name: "revert_chat_changes",
  description:
    "Composite: undo every snapshot tagged with one chat's branch by filing a SINGLE propose_revert_site " +
    "proposal targeting the snapshot right before the chat started. One Owner click rewinds the whole chat. " +
    "WARNING: rewinds the FULL SITE to that pre-chat state — any non-chat edit since then is also reverted. " +
    "Use when the operator says 'undo everything in this chat' or 'roll back the changes from session <id>'. " +
    "For surgical per-entity rollback, prefer propose_revert_page / propose_revert_module individually. " +
    "Refuses when the chat is the very first activity on the site (no pre-chat snapshot to revert to) or " +
    "when the chat touched more entities than `maxEntities` (default 20) — a safety cap so a wide-ranging chat " +
    "isn't accidentally one-click-reverted.",
  schema: revertChatChangesToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["chatSessionId"],
    properties: {
      chatSessionId: { type: "string", format: "uuid" },
      maxEntities: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const maxEntities = input.maxEntities ?? 20;

    // STEP 1 — resolve the chat's branch_id. Bypass the Query API
    // because chat_sessions doesn't have a public read op that exposes
    // chat_branch_id by session id. Same SQL pattern as
    // packages/admin-core/src/ops/chat/stage.ts:79.
    const adminUrl = process.env.ADMIN_DATABASE_URL;
    if (!adminUrl) {
      return {
        ok: false,
        content: "revert_chat_changes: ADMIN_DATABASE_URL not set; cannot resolve chat branch.",
      };
    }
    let chatBranchId: string | null = null;
    {
      const sql = new SQL(adminUrl);
      try {
        const rows = (await sql.unsafe(
          `SELECT chat_branch_id::text AS chat_branch_id FROM chat_sessions WHERE id = $1::uuid`,
          [input.chatSessionId],
        )) as unknown as { chat_branch_id: string | null }[];
        chatBranchId = rows[0]?.chat_branch_id ?? null;
      } finally {
        await sql.end();
      }
    }
    if (!chatBranchId) {
      return {
        ok: false,
        content: `revert_chat_changes: chat session ${input.chatSessionId} not found, or it has no branch_id (never wrote anything).`,
      };
    }

    // STEP 2 — enumerate the chat's snapshots.
    const chatSnapshotsR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "snapshots.list",
      {
        forChatBranchId: chatBranchId,
        limit: 200,
        includeArchived: true,
      },
    );
    if (!chatSnapshotsR.ok) {
      return {
        ok: false,
        content: `revert_chat_changes: snapshots.list failed: ${describeError(chatSnapshotsR.error)}`,
      };
    }
    const chatSnapshots = (chatSnapshotsR.value as { snapshots: SnapshotRow[] }).snapshots;
    if (chatSnapshots.length === 0) {
      return {
        ok: false,
        content: `revert_chat_changes: chat ${input.chatSessionId} (branch=${chatBranchId}) has no snapshots — nothing to revert. (If the chat is unpublished, discard it from the chat list instead.)`,
      };
    }
    const totalEntityCount = chatSnapshots.reduce(
      (acc, s) => acc + s.moduleCount + s.templateCount + s.pageCount + s.pageLayoutCount,
      0,
    );
    if (totalEntityCount > maxEntities) {
      return {
        ok: false,
        content: `revert_chat_changes: chat touched ${totalEntityCount} entity-snapshots across ${chatSnapshots.length} snapshots — exceeds the maxEntities cap (${maxEntities}). Use propose_revert_page / propose_revert_module per-entity, or re-call with maxEntities=${totalEntityCount} to override (NOT recommended without operator confirmation).`,
      };
    }

    // STEP 3 — find the pre-chat snapshot. snapshots.list returns
    // reverse-chronological, so the chat's first snapshot is the
    // tail. We then need the timeline entry IMMEDIATELY before it.
    const firstChatSnapshot = chatSnapshots[chatSnapshots.length - 1]!;
    const priorR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "snapshots.list", {
      before: firstChatSnapshot.createdAt,
      limit: 50,
      includeArchived: true,
    });
    if (!priorR.ok) {
      return {
        ok: false,
        content: `revert_chat_changes: snapshots.list (prior lookup) failed: ${describeError(priorR.error)}`,
      };
    }
    const priorSnapshots = (priorR.value as { snapshots: SnapshotRow[] }).snapshots;
    const preChat = priorSnapshots.find((s) => s.chatBranchId !== chatBranchId);
    if (!preChat) {
      return {
        ok: false,
        content: `revert_chat_changes: no snapshot exists before chat ${input.chatSessionId}. Reverting would leave the site empty, which this tool refuses to do. Discard the chat from the chat list instead.`,
      };
    }

    // STEP 4 — file the propose_revert_site proposal. The actual
    // revert happens when the Owner clicks Approve at
    // /security/snapshots/pending.
    const proposeR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "snapshots.propose_revert_site",
      { snapshotId: preChat.id },
    );
    if (!proposeR.ok) {
      return {
        ok: false,
        content: `revert_chat_changes: snapshots.propose_revert_site failed: ${describeError(proposeR.error)}`,
      };
    }
    const v = proposeR.value as { proposalId: string; preview?: { affectedEntityCount?: number } };
    const affected = v.preview?.affectedEntityCount ?? totalEntityCount;
    return {
      ok: true,
      content:
        `Queued proposal ${v.proposalId}: revert_chat_changes — chat ${input.chatSessionId} (${chatSnapshots.length} snapshots, ${totalEntityCount} entity-snapshots) → rewinds site to pre-chat snapshot ${preChat.id} (${affected} entities will be restored). ` +
        `WARNING: this also reverts any NON-chat edits between then and now. ` +
        `Owner clicks Approve at /security/snapshots/pending to apply.`,
    };
  },
};
