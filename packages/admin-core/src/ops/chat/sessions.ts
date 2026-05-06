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

import { defineOperation } from "@caelo-cms/query-api";
import { chatCreateSessionInput, chatRenameSessionInput, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const pinnedElement = z
  .object({
    moduleId: z.string().uuid(),
    selector: z.string(),
    label: z.string(),
  })
  .strict();

const sessionRow = z.object({
  id: z.string(),
  title: z.string(),
  createdBy: z.string(),
  chatBranchId: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  publishedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  pinnedElements: z.array(pinnedElement),
  /** P6.7.4 — when set, the chat is scoped to a single page. */
  pageId: z.string().nullable(),
  /** P6.7.4 — when set, the chat is scoped to a template. */
  templateId: z.string().nullable(),
});

interface PinnedElement {
  moduleId: string;
  selector: string;
  label: string;
}

function parsePinnedElements(raw: unknown): PinnedElement[] {
  const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (e): e is PinnedElement =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as PinnedElement).moduleId === "string" &&
      typeof (e as PinnedElement).selector === "string" &&
      typeof (e as PinnedElement).label === "string",
  );
}

export const listChatSessionsOp = defineOperation({
  name: "chat.list_sessions",
  // CLAUDE.md §11: read surface open to AI. The AI uses this in
  // long-running sessions to find prior conversations on the same
  // page / template and cite them.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    includeArchived: z.boolean().default(false),
    /** P6.7.4 — when set, only return sessions bound to this page. */
    pageId: z.string().uuid().nullable().optional(),
    /** P6.7.4 — when set, only return sessions bound to this template. */
    templateId: z.string().uuid().nullable().optional(),
    /** §11 AI-first — substring search on the session title. */
    query: z.string().max(256).optional(),
  }),
  output: z.object({ sessions: z.array(sessionRow) }),
  handler: async (ctx, input, tx) => {
    const archivedFilter = input.includeArchived ? sql`` : sql`AND archived_at IS NULL`;
    const pageFilter = input.pageId ? sql`AND page_id = ${input.pageId}::uuid` : sql``;
    const templateFilter = input.templateId
      ? sql`AND template_id = ${input.templateId}::uuid`
      : sql``;
    const queryFilter =
      input.query && input.query.length > 0 ? sql`AND title ILIKE ${`%${input.query}%`}` : sql``;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, title, created_by::text AS created_by,
             chat_branch_id::text AS chat_branch_id,
             created_at, last_active_at, published_at, archived_at,
             pinned_elements,
             page_id::text     AS page_id,
             template_id::text AS template_id
      FROM chat_sessions
      WHERE created_by = ${ctx.actorId}::uuid
        AND subagent_role IS NULL
        ${archivedFilter} ${pageFilter} ${templateFilter} ${queryFilter}
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
      pinned_elements: unknown;
      page_id: string | null;
      template_id: string | null;
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
        pinnedElements: parsePinnedElements(r.pinned_elements),
        pageId: r.page_id,
        templateId: r.template_id,
      })),
    });
  },
});

export const createChatSessionOp = defineOperation({
  name: "chat.create_session",
  // CLAUDE.md §11: AI may spawn scoped chats (e.g. import-site skill
  // creates a session per imported page). The session row is owned by
  // the calling actor; AI sessions surface in the same picker.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: chatCreateSessionInput,
  output: z.object({ chatSessionId: z.string(), chatBranchId: z.string() }),
  handler: async (ctx, input, tx) => {
    const title = input.title?.trim() || "New chat";
    const pageId = input.pageId ?? null;
    const templateId = input.templateId ?? null;
    const subagentRole = input.subagentRole ?? null;
    const rows = (await tx.execute(sql`
      INSERT INTO chat_sessions (title, created_by, chat_branch_id, page_id, template_id, subagent_role)
      VALUES (
        ${title},
        ${ctx.actorId}::uuid,
        gen_random_uuid(),
        ${pageId ? sql`${pageId}::uuid` : sql`NULL`},
        ${templateId ? sql`${templateId}::uuid` : sql`NULL`},
        ${subagentRole}
      )
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
      requestId: ctx.requestId,
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
  // CLAUDE.md §11: read surface open to AI. The chat-runner already
  // executes as AI; without this scope it would have to use the human
  // ctx detour for every session reload.
  actorScope: ["human", "ai", "system"],
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
             created_at, last_active_at, published_at, archived_at,
             pinned_elements,
             page_id::text     AS page_id,
             template_id::text AS template_id
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
      pinned_elements: unknown;
      page_id: string | null;
      template_id: string | null;
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
        pinnedElements: parsePinnedElements(session.pinned_elements),
        pageId: session.page_id,
        templateId: session.template_id,
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
  // v0.2.19 — title is just metadata; AI-renaming a chat to a more
  // descriptive label after a few turns is a useful affordance.
  actorScope: ["human", "ai", "system"],
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
      requestId: ctx.requestId,
      operation: "chat.rename_session",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
    });
    return ok({});
  },
});

// Pinning is a UI affordance the human owner of the chat invokes; the AI
// never reaches into it (an AI tool call rewriting another user's
// `pinned_elements` doesn't make sense anyway because the WHERE clause
// scopes by created_by). Keep this human-only.
export const setPinnedElementsOp = defineOperation({
  name: "chat.set_pinned_elements",
  // Why human-only: per-user UI state; AI uses chips on the message instead.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      pinnedElements: z.array(pinnedElement),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE chat_sessions
      SET pinned_elements = ${JSON.stringify(input.pinnedElements)}::jsonb
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    `);
    return ok({});
  },
});

export const archiveChatSessionOp = defineOperation({
  name: "chat.archive_session",
  // CLAUDE.md §11: AI archives its own scoped sessions when done.
  // RLS enforces created_by ownership.
  actorScope: ["human", "ai", "system"],
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
      requestId: ctx.requestId,
      operation: "chat.archive_session",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
    });
    return ok({});
  },
});

/**
 * P6.6 polish — return the distinct module ids that have at least one
 * snapshot tagged with this chat session's branch. The DiffPanel uses
 * this to render only branch-edited rows in its checkbox list, instead
 * of every module on the page. Read-only.
 */
export const listBranchEditedModulesOp = defineOperation({
  name: "chat.branch_edited_modules",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({ moduleIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ms.module_id::text AS module_id
      FROM module_snapshots ms
      JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
      JOIN chat_sessions cs  ON cs.chat_branch_id = ss.chat_branch_id
      WHERE cs.id = ${input.chatSessionId}::uuid
    `)) as unknown as { module_id: string }[];
    return ok({ moduleIds: rows.map((r) => r.module_id) });
  },
});
