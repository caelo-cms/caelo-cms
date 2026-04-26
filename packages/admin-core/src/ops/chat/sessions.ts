// SPDX-License-Identifier: MPL-2.0

/**
 * Chat session lifecycle ops.
 *
 *   chat.list_sessions    — caller's sessions, most-recent first.
 *   chat.create_session   — new session with its own chat_branch_id.
 *   chat.get_session      — load one session + its messages.
 *   chat.rename_session   — title edit.
 *   chat.archive_session  — soft-archive (sets archived_at).
 */

import { defineOperation } from "@caelo/query-api";
import { chatCreateSessionInput, chatRenameSessionInput, err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const sessionRow = z.object({
  id: z.string(),
  title: z.string(),
  createdBy: z.string(),
  chatBranchId: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  publishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
});

export const listChatSessionsOp = defineOperation({
  name: "chat.list_sessions",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  output: z.object({ sessions: z.array(sessionRow) }),
  handler: async (ctx, input, tx) => {
    const archivedFilter = input.includeArchived ? sql`` : sql`AND archived_at IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, title, created_by::text AS created_by,
             chat_branch_id::text AS chat_branch_id,
             created_at, last_active_at, published_at, archived_at
      FROM chat_sessions
      WHERE created_by = ${ctx.actorId}::uuid ${archivedFilter}
      ORDER BY last_active_at DESC
      LIMIT 100
    `)) as unknown as {
      id: string;
      title: string;
      created_by: string;
      chat_branch_id: string;
      created_at: string | Date;
      last_active_at: string | Date;
      published_at: string | Date | null;
      archived_at: string | Date | null;
    }[];
    const iso = (v: string | Date | null): string | null => {
      if (v === null) return null;
      return v instanceof Date ? v.toISOString() : String(v);
    };
    return ok({
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdBy: r.created_by,
        chatBranchId: r.chat_branch_id,
        createdAt: iso(r.created_at) ?? "",
        lastActiveAt: iso(r.last_active_at) ?? "",
        publishedAt: iso(r.published_at),
        archivedAt: iso(r.archived_at),
      })),
    });
  },
});

export const createChatSessionOp = defineOperation({
  name: "chat.create_session",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: chatCreateSessionInput,
  output: z.object({ chatSessionId: z.string(), chatBranchId: z.string() }),
  handler: async (ctx, input, tx) => {
    const title = input.title?.trim() || "New chat";
    const rows = (await tx.execute(sql`
      INSERT INTO chat_sessions (title, created_by, chat_branch_id)
      VALUES (${title}, ${ctx.actorId}::uuid, gen_random_uuid())
      RETURNING id::text AS id, chat_branch_id::text AS chat_branch_id
    `)) as unknown as { id: string; chat_branch_id: string }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "chat.create_session",
        message: "session insert returned no row",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "chat.create_session",
      input,
      succeeded: true,
      entityId: row.id,
      resultSummary: `branch=${row.chat_branch_id.slice(0, 8)}`,
    });
    return ok({ chatSessionId: row.id, chatBranchId: row.chat_branch_id });
  },
});

const sessionMessagesRow = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z.unknown().nullable(),
  toolCallId: z.string().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  createdAt: z.string(),
});

export const getChatSessionOp = defineOperation({
  name: "chat.get_session",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }),
  output: z.object({
    session: sessionRow,
    messages: z.array(sessionMessagesRow),
  }),
  handler: async (ctx, input, tx) => {
    const sessionRows = (await tx.execute(sql`
      SELECT id::text AS id, title, created_by::text AS created_by,
             chat_branch_id::text AS chat_branch_id,
             created_at, last_active_at, published_at, archived_at
      FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
      LIMIT 1
    `)) as unknown as {
      id: string;
      title: string;
      created_by: string;
      chat_branch_id: string;
      created_at: string | Date;
      last_active_at: string | Date;
      published_at: string | Date | null;
      archived_at: string | Date | null;
    }[];
    const session = sessionRows[0];
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.get_session",
        message: "session not found",
      });
    }
    const msgs = (await tx.execute(sql`
      SELECT id::text AS id, role, content, tool_calls, tool_call_id,
             tokens_in, tokens_out, created_at
      FROM chat_messages
      WHERE chat_session_id = ${input.chatSessionId}::uuid
      ORDER BY created_at ASC
    `)) as unknown as {
      id: string;
      role: "user" | "assistant" | "tool";
      content: string;
      tool_calls: unknown;
      tool_call_id: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      created_at: string | Date;
    }[];
    const iso = (v: string | Date | null): string | null => {
      if (v === null) return null;
      return v instanceof Date ? v.toISOString() : String(v);
    };
    return ok({
      session: {
        id: session.id,
        title: session.title,
        createdBy: session.created_by,
        chatBranchId: session.chat_branch_id,
        createdAt: iso(session.created_at) ?? "",
        lastActiveAt: iso(session.last_active_at) ?? "",
        publishedAt: iso(session.published_at),
        archivedAt: iso(session.archived_at),
      },
      messages: msgs.map((m) => {
        const parsedTools =
          typeof m.tool_calls === "string" ? (JSON.parse(m.tool_calls) as unknown) : m.tool_calls;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: parsedTools ?? null,
          toolCallId: m.tool_call_id,
          tokensIn: m.tokens_in,
          tokensOut: m.tokens_out,
          createdAt: iso(m.created_at) ?? "",
        };
      }),
    });
  },
});

export const renameChatSessionOp = defineOperation({
  name: "chat.rename_session",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: chatRenameSessionInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE chat_sessions SET title = ${input.title}, last_active_at = now()
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "chat.rename_session",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
    });
    return ok({});
  },
});

export const archiveChatSessionOp = defineOperation({
  name: "chat.archive_session",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE chat_sessions SET archived_at = now()
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "chat.archive_session",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
    });
    return ok({});
  },
});
