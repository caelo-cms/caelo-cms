// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — the "Open changes" view.
 *
 *   chat.list_open_changes        every open chat with unstaged changes or
 *                                 locks: what it changed, what it holds,
 *                                 and the recent lock takeovers involving
 *                                 it. Feeds the /content/changes overview
 *                                 (Stage all / Stage selected / Discard per
 *                                 chat) and the AI's
 *                                 `list_unpublished_changes({ allChats })`.
 *   chat.drain_takeover_notices   tool dispatch turns undelivered takeover
 *                                 records into notes on the next tool result
 *                                 of BOTH chats involved.
 *
 * Decision-support per CLAUDE.md §1A: each chat row carries whose chat it
 * is (`isMine` — the operator can only Stage/Discard their own), its anchor
 * page, and labels for every change and lock, so neither the operator nor
 * the AI has to resolve ids.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type BranchKind, sessionPendingSql } from "../../draft.js";
import { drainTakeoverNotices } from "../../lock-takeover.js";
import { loadPendingChanges, pendingChangesSchema } from "./stage.js";

/** Open chats listed at most (most recently active first). */
const MAX_CHATS = 100;
/** Takeovers shown per chat. */
const TAKEOVERS_PER_CHAT = 10;

const openChatSchema = z
  .object({
    chatSessionId: z.string(),
    title: z.string(),
    /** True when the caller owns the chat — only then may they Stage or Discard it. */
    isMine: z.boolean(),
    /** Issue #620 — 'draft' (shared draft), 'experiment' / 'migration' (isolated) or 'legacy'. */
    branchKind: z.enum(["draft", "experiment", "migration", "legacy"]),
    anchorPageSlug: z.string().nullable(),
    lastActiveAt: z.string(),
    lastStagedAt: z.string().nullable(),
    /** Distinct entities changed since the last Stage (the pending refs). */
    pendingCount: z.number().int().nonnegative(),
    changes: pendingChangesSchema,
    locks: z.array(
      z
        .object({
          entityKind: z.string(),
          entityId: z.string(),
          label: z.string(),
          lockedAt: z.string(),
        })
        .strict(),
    ),
    takeovers: z.array(
      z
        .object({
          /** 'adopted' = this chat took the entity over; 'lost' = another chat took it from this one. */
          direction: z.enum(["adopted", "lost"]),
          entityKind: z.string(),
          label: z.string(),
          otherChatTitle: z.string(),
          adoptedSnapshotCount: z.number().int().nonnegative(),
          at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

/** One open chat as the overview renders it. */
export type OpenChatChanges = z.infer<typeof openChatSchema>;

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export const listOpenChangesOp = defineOperation({
  name: "chat.list_open_changes",
  // CLAUDE.md §11: read surface open to the AI — it answers "what is still
  // unstaged across my chats?" without a round-trip to the operator.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Only the caller's own chats (default: every editor's open chats). */
      mineOnly: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ chats: z.array(openChatSchema) }),
  handler: async (ctx, input, tx) => {
    const sessions = (await tx.execute(sql`
      SELECT cs.id::text AS id, cs.title, cs.created_by::text AS created_by,
             cs.chat_branch_id::text AS chat_branch_id, cs.branch_kind,
             cs.last_active_at, cs.last_staged_at,
             p.slug AS page_slug
      FROM chat_sessions cs
      LEFT JOIN pages p ON p.id = cs.page_id AND p.deleted_at IS NULL
      WHERE cs.published_at IS NULL AND cs.archived_at IS NULL AND cs.discarded_at IS NULL
        AND cs.subagent_role IS NULL
        ${input.mineOnly ? sql`AND cs.created_by = ${ctx.actorId}::uuid` : sql``}
        -- Only chats with something open, BEFORE the cap: an older chat
        -- with unstaged work must not fall off behind newer idle ones.
        AND (
          EXISTS (
            SELECT 1 FROM site_snapshots ss WHERE ${sessionPendingSql()}
          )
          OR EXISTS (SELECT 1 FROM chat_entity_locks l WHERE l.chat_session_id = cs.id)
        )
      ORDER BY cs.last_active_at DESC
      LIMIT ${MAX_CHATS}
    `)) as unknown as {
      id: string;
      title: string;
      created_by: string;
      chat_branch_id: string;
      branch_kind: BranchKind;
      last_active_at: string | Date;
      last_staged_at: string | Date | null;
      page_slug: string | null;
    }[];

    const chats: OpenChatChanges[] = [];
    for (const s of sessions) {
      const changes = await loadPendingChanges(tx, {
        chatSessionId: s.id,
        branchId: s.chat_branch_id,
        kind: s.branch_kind,
        createdBy: s.created_by,
        title: s.title,
        publishedAt: null,
        archivedAt: null,
        discardedAt: null,
      });
      const pendingCount =
        changes.pending.pages.length +
        changes.pending.globals.length +
        changes.pending.lists.length;

      const locks = (await tx.execute(sql`
        SELECT l.entity_kind, l.entity_id::text AS entity_id, l.locked_at,
               COALESCE(
                 m.display_name, t.display_name, COALESCE(pg.title, pg.slug),
                 la.display_name, sset.display_name, th.display_name,
                 COALESCE(ci.display_name, ci.slug, ci_module.slug), r.from_path
               ) AS label
        FROM chat_entity_locks l
        LEFT JOIN modules m ON l.entity_kind = 'module' AND m.id = l.entity_id
        LEFT JOIN templates t ON l.entity_kind = 'template' AND t.id = l.entity_id
        LEFT JOIN pages pg ON l.entity_kind IN ('page', 'pageLayout') AND pg.id = l.entity_id
        LEFT JOIN layouts la ON l.entity_kind = 'layout' AND la.id = l.entity_id
        LEFT JOIN structured_sets sset ON l.entity_kind = 'structuredSet' AND sset.id = l.entity_id
        LEFT JOIN themes th ON l.entity_kind = 'theme' AND th.id = l.entity_id
        LEFT JOIN content_instances ci ON l.entity_kind = 'contentInstance' AND ci.id = l.entity_id
        LEFT JOIN modules ci_module ON ci_module.id = ci.module_id
        LEFT JOIN redirects r ON l.entity_kind = 'redirect' AND r.id = l.entity_id
        WHERE l.chat_session_id = ${s.id}::uuid
        ORDER BY l.locked_at DESC
      `)) as unknown as {
        entity_kind: string;
        entity_id: string;
        locked_at: string | Date;
        label: string | null;
      }[];

      const takeovers = (await tx.execute(sql`
        SELECT CASE WHEN to_chat_session_id = ${s.id}::uuid THEN 'adopted' ELSE 'lost' END AS direction,
               entity_kind, label,
               CASE WHEN to_chat_session_id = ${s.id}::uuid THEN from_chat_title ELSE to_chat_title END
                 AS other_chat_title,
               adopted_snapshot_count, created_at
        FROM chat_lock_takeovers
        WHERE to_chat_session_id = ${s.id}::uuid OR from_chat_session_id = ${s.id}::uuid
        ORDER BY created_at DESC
        LIMIT ${TAKEOVERS_PER_CHAT}
      `)) as unknown as {
        direction: "adopted" | "lost";
        entity_kind: string;
        label: string;
        other_chat_title: string;
        adopted_snapshot_count: number;
        created_at: string | Date;
      }[];

      // A chat with nothing unstaged and nothing held is not an "open
      // change" — it is just a conversation.
      if (pendingCount === 0 && locks.length === 0) continue;

      chats.push({
        chatSessionId: s.id,
        title: s.title,
        isMine: s.created_by === ctx.actorId,
        branchKind: s.branch_kind,
        anchorPageSlug: s.page_slug,
        lastActiveAt: iso(s.last_active_at) ?? "",
        lastStagedAt: iso(s.last_staged_at),
        pendingCount,
        changes,
        locks: locks.map((l) => ({
          entityKind: l.entity_kind,
          entityId: l.entity_id,
          label: l.label ?? `${l.entity_kind} ${l.entity_id}`,
          lockedAt: iso(l.locked_at) ?? "",
        })),
        takeovers: takeovers.map((t) => ({
          direction: t.direction,
          entityKind: t.entity_kind,
          label: t.label,
          otherChatTitle: t.other_chat_title,
          adoptedSnapshotCount: t.adopted_snapshot_count,
          at: iso(t.created_at) ?? "",
        })),
      });
    }
    return ok({ chats });
  },
});

export const drainTakeoverNoticesOp = defineOperation({
  name: "chat.drain_takeover_notices",
  // Why human-only: dispatch-internal — the chat-runner and Power-MCP tool
  // dispatch call it after every tool call (as the operator) to append
  // takeover notes to that tool result; the AI reads the notes there and
  // must not be able to mark them delivered unseen.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({ notes: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    return ok({ notes: await drainTakeoverNotices(tx, input.chatSessionId) });
  },
});
