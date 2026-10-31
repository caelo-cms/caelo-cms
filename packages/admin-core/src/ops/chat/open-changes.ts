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

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type BranchKind, sessionHasPendingSql } from "../../draft.js";
import { drainTakeoverNotices } from "../../lock-takeover.js";
import { loadPendingChangesFor, pendingChangesSchema } from "./stage.js";

/** Open chats per page at most (most recently active first). */
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
    /** The anchor page's URL path (unique, unlike its slug). */
    anchorPagePath: z.string().nullable(),
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
  readScope: "request",
  // CLAUDE.md §11: read surface open to the AI — it answers "what is still
  // unstaged across my chats?" without a round-trip to the operator.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Only the caller's own chats (default: every editor's open chats). */
      mineOnly: z.boolean().default(false),
      /** Chats per page, most recently active first (default and maximum 100). */
      limit: z.number().int().min(1).max(MAX_CHATS).default(MAX_CHATS),
      /** The `nextCursor` of the previous page; omit for the first page. */
      cursor: z.string().max(200).optional(),
    })
    .strict(),
  output: z.object({
    chats: z.array(openChatSchema),
    /** Pass as `cursor` for the next page; null on the last page. */
    nextCursor: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !after) {
      return err({
        kind: "HandlerError",
        operation: "chat.list_open_changes",
        message:
          "cursor is not one this op returned — pass the nextCursor of the previous page unchanged, or omit it for the first page",
      });
    }
    // Issue #1268 — one keyset page of open chats, then their changes,
    // locks and takeovers in one statement each: a constant number of
    // statements, each bounded by the chats on the page.
    const sessions = (await tx.execute(sql`
      SELECT cs.id::text AS id, cs.title, cs.created_by::text AS created_by,
             cs.chat_branch_id::text AS chat_branch_id, cs.branch_kind,
             to_char(cs.last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_active_at,
             cs.last_staged_at,
             p.current_path AS page_path
      FROM chat_sessions cs
      LEFT JOIN pages p ON p.id = cs.page_id AND p.deleted_at IS NULL
      WHERE cs.published_at IS NULL AND cs.archived_at IS NULL AND cs.discarded_at IS NULL
        AND cs.subagent_role IS NULL
        ${input.mineOnly ? sql`AND cs.created_by = ${ctx.actorId}::uuid` : sql``}
        ${after ? sql`AND (cs.last_active_at, cs.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
        -- Only chats with something open, BEFORE the page cut: an older
        -- chat with unstaged work must not fall off behind newer idle ones.
        AND (
          ${sessionHasPendingSql("cs")}
          OR EXISTS (SELECT 1 FROM chat_entity_locks l WHERE l.chat_session_id = cs.id)
        )
      ORDER BY cs.last_active_at DESC, cs.id DESC
      LIMIT ${input.limit + 1}
    `)) as unknown as {
      id: string;
      title: string;
      created_by: string;
      chat_branch_id: string;
      branch_kind: BranchKind;
      last_active_at: string;
      last_staged_at: string | Date | null;
      page_path: string | null;
    }[];
    const page = sessions.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor =
      sessions.length > input.limit && last ? encodeCursor(last.last_active_at, last.id) : null;
    if (page.length === 0) return ok({ chats: [], nextCursor });
    const ids = uuidArray(page.map((s) => s.id));

    const changesByChat = await loadPendingChangesFor(
      tx,
      page.map((s) => ({ chatSessionId: s.id, branchId: s.chat_branch_id, kind: s.branch_kind })),
    );

    const locks = (await tx.execute(sql`
      SELECT l.chat_session_id::text AS chat, l.entity_kind, l.entity_id::text AS entity_id, l.locked_at,
             COALESCE(
               m.display_name, t.display_name, COALESCE(pg.title, pg.slug),
               la.display_name, COALESCE(lt.definition->>'name', lt.slug), COALESCE(li.name, li.slug),
               COALESCE(pt.definition->>'name', pt.slug), th.display_name,
               COALESCE(ci.display_name, ci.slug, ci_module.slug), r.from_path
             ) AS label
      FROM chat_entity_locks l
      LEFT JOIN modules m ON l.entity_kind = 'module' AND m.id = l.entity_id
      LEFT JOIN templates t ON l.entity_kind = 'template' AND t.id = l.entity_id
      LEFT JOIN pages pg ON l.entity_kind IN ('page', 'pageLayout') AND pg.id = l.entity_id
      LEFT JOIN layouts la ON l.entity_kind = 'layout' AND la.id = l.entity_id
      LEFT JOIN list_types lt ON l.entity_kind = 'listType' AND lt.id = l.entity_id
      LEFT JOIN lists li ON l.entity_kind = 'list' AND li.id = l.entity_id
      LEFT JOIN page_types pt ON l.entity_kind = 'pageType' AND pt.id = l.entity_id
      LEFT JOIN themes th ON l.entity_kind = 'theme' AND th.id = l.entity_id
      LEFT JOIN content_instances ci ON l.entity_kind = 'contentInstance' AND ci.id = l.entity_id
      LEFT JOIN modules ci_module ON ci_module.id = ci.module_id
      LEFT JOIN redirects r ON l.entity_kind = 'redirect' AND r.id = l.entity_id
      WHERE l.chat_session_id = ANY(${ids})
      ORDER BY l.locked_at DESC
    `)) as unknown as {
      chat: string;
      entity_kind: string;
      entity_id: string;
      locked_at: string | Date;
      label: string | null;
    }[];

    const takeovers = (await tx.execute(sql`
      SELECT c.id::text AS chat, t.*
      FROM unnest(${ids}) AS c(id)
      CROSS JOIN LATERAL (
        SELECT CASE WHEN to_chat_session_id = c.id THEN 'adopted' ELSE 'lost' END AS direction,
               entity_kind, label,
               CASE WHEN to_chat_session_id = c.id THEN from_chat_title ELSE to_chat_title END
                 AS other_chat_title,
               adopted_snapshot_count, created_at
        FROM chat_lock_takeovers
        WHERE to_chat_session_id = c.id OR from_chat_session_id = c.id
        ORDER BY created_at DESC
        LIMIT ${TAKEOVERS_PER_CHAT}
      ) t
      ORDER BY t.created_at DESC
    `)) as unknown as {
      chat: string;
      direction: "adopted" | "lost";
      entity_kind: string;
      label: string;
      other_chat_title: string;
      adopted_snapshot_count: number;
      created_at: string | Date;
    }[];

    const chats: OpenChatChanges[] = [];
    for (const s of page) {
      const changes = changesByChat.get(s.id);
      if (!changes) continue;
      // The pill's count (#1268): every pending entity, picked for publish
      // or not — an isolated chat's 'staged' marks are still unstaged here.
      const pendingCount = [changes.pending, changes.staged].reduce(
        (n, g) => n + g.pages.length + g.globals.length + g.lists.length,
        0,
      );
      const own = locks.filter((l) => l.chat === s.id);
      chats.push({
        chatSessionId: s.id,
        title: s.title,
        isMine: s.created_by === ctx.actorId,
        branchKind: s.branch_kind,
        anchorPagePath: s.page_path,
        lastActiveAt: s.last_active_at,
        lastStagedAt: iso(s.last_staged_at),
        pendingCount,
        changes,
        locks: own.map((l) => ({
          entityKind: l.entity_kind,
          entityId: l.entity_id,
          label: l.label ?? `${l.entity_kind} ${l.entity_id}`,
          lockedAt: iso(l.locked_at) ?? "",
        })),
        takeovers: takeovers
          .filter((t) => t.chat === s.id)
          .map((t) => ({
            direction: t.direction,
            entityKind: t.entity_kind,
            label: t.label,
            otherChatTitle: t.other_chat_title,
            adoptedSnapshotCount: t.adopted_snapshot_count,
            at: iso(t.created_at) ?? "",
          })),
      });
    }
    return ok({ chats, nextCursor });
  },
});

/** A keyset cursor: the last chat of a page (activity time + id). */
function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}

const cursorSchema = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict();

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const drainTakeoverNoticesOp = defineOperation({
  name: "chat.drain_takeover_notices",
  readScope: "request",
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
