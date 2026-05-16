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
import { releaseChatLocks } from "../../locks.js";

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
  /** v0.2.54 — per-chat extended-thinking toggle (default off). */
  extendedThinkingEnabled: z.boolean(),
  /** v0.2.54 — per-chat thinking budget override; null = chat-runner default. */
  extendedThinkingBudgetTokens: z.number().int().nullable(),
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
             template_id::text AS template_id,
             extended_thinking_enabled,
             extended_thinking_budget_tokens
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
      extended_thinking_enabled: boolean;
      extended_thinking_budget_tokens: number | null;
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
        extendedThinkingEnabled: r.extended_thinking_enabled,
        extendedThinkingBudgetTokens: r.extended_thinking_budget_tokens,
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

    // v0.5.8 — per-page chat gate. Two parallel chats editing the same
    // page would either compete on the per-page lock (when both try to
    // write) or silently diverge until publish. Reject creation upfront
    // so the operator gets pointed at the existing chat instead.
    //
    // Global chats (pageId IS NULL) stay unrestricted — globals like
    // theme / structured-sets / modules cross many pages, and the
    // per-entity lock + staging picker handle their conflict surface.
    if (pageId) {
      const existing = (await tx.execute(sql`
        SELECT id::text AS id, title FROM chat_sessions
        WHERE page_id = ${pageId}::uuid AND published_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `)) as unknown as { id: string; title: string }[];
      const open = existing[0];
      if (open) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "chat.create_session",
          input,
          succeeded: false,
          resultSummary: `page-gate-conflict open=${open.id.slice(0, 8)}`,
        });
        return err({
          kind: "HandlerError",
          operation: "chat.create_session",
          message: `page ${pageId} already has an open chat (${open.title}, id=${open.id}); resume that chat or publish it first`,
        });
      }
    }

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
  /** v0.2.54 — extended-thinking blocks for assistant turns. */
  thinkingBlocks: z.array(z.object({ thinking: z.string(), signature: z.string() })).nullable(),
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
             template_id::text AS template_id,
             extended_thinking_enabled,
             extended_thinking_budget_tokens
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
      extended_thinking_enabled: boolean;
      extended_thinking_budget_tokens: number | null;
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
             tokens_in, tokens_out, created_at, thinking_blocks
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
      thinking_blocks: unknown;
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
        extendedThinkingEnabled: session.extended_thinking_enabled,
        extendedThinkingBudgetTokens: session.extended_thinking_budget_tokens,
      },
      messages: msgs.map((m) => {
        const parsedTools =
          typeof m.tool_calls === "string" ? (JSON.parse(m.tool_calls) as unknown) : m.tool_calls;
        const parsedThinking =
          typeof m.thinking_blocks === "string"
            ? (JSON.parse(m.thinking_blocks) as unknown)
            : m.thinking_blocks;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: parsedTools ?? null,
          toolCallId: m.tool_call_id,
          tokensIn: m.tokens_in,
          tokensOut: m.tokens_out,
          createdAt: iso(m.created_at) ?? "",
          thinkingBlocks:
            Array.isArray(parsedThinking) && parsedThinking.length > 0
              ? (parsedThinking as { thinking: string; signature: string }[])
              : null,
        };
      }),
    });
  },
});

/**
 * v0.2.54 — toggle extended thinking + optional budget on a chat session.
 * Per-chat preference (chat-runner reads it on every turn) so the operator
 * can flip thinking on for a hard problem without affecting other chats.
 *
 * Why human-only: per-user UI state; the AI doesn't choose to think
 * harder — that's an operator decision, mirroring the model's UX in
 * other Anthropic surfaces (Claude.ai's "Extended thinking" toggle is
 * also user-facing only).
 */
/**
 * v0.6.0 alpha.3 — read the chat session's branch id WITHOUT the
 * created_by filter that `chat.get_session` applies. The
 * AI-callable revert_chat_changes tool needs to look up the branch
 * id for a chat that the human user owns (the AI is not the
 * creator). `chat.get_session` filters by `created_by = ctx.actorId`
 * which silently returns null for AI callers; this op skips that
 * filter for AI/system actors so the branch id is reachable.
 *
 * Returns ONLY the branch id and the creator — nothing sensitive.
 * The full session record stays guarded by `chat.get_session`.
 */
export const getChatBranchIdOp = defineOperation({
  name: "chat.get_branch_id",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }),
  output: z.object({
    chatBranchId: z.string().nullable(),
    createdBy: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT chat_branch_id::text AS chat_branch_id,
             created_by::text AS created_by
      FROM chat_sessions
      WHERE id = ${input.chatSessionId}::uuid
      LIMIT 1
    `)) as unknown as { chat_branch_id: string | null; created_by: string | null }[];
    const row = rows[0];
    if (!row) return ok({ chatBranchId: null, createdBy: null });
    return ok({ chatBranchId: row.chat_branch_id, createdBy: row.created_by });
  },
});

export const setChatExtendedThinkingOp = defineOperation({
  name: "chat.set_extended_thinking",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      enabled: z.boolean(),
      // Anthropic min 1024; CHECK constraint on the column also enforces
      // ≤ 64000. Null clears the override so the chat-runner default
      // (10000) applies.
      budgetTokens: z.number().int().min(1024).max(64000).nullable().optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE chat_sessions
      SET extended_thinking_enabled = ${input.enabled},
          extended_thinking_budget_tokens = ${input.budgetTokens ?? null},
          last_active_at = now()
      WHERE id = ${input.chatSessionId}::uuid AND created_by = ${ctx.actorId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.set_extended_thinking",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
    });
    return ok({});
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
    // v0.5.0 — archiving releases any per-entity locks the chat held
    // so other chats can edit those globals again.
    await releaseChatLocks(tx, input.chatSessionId);
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

/**
 * v0.2.76 — Count distinct entities edited on the chat branch
 * across ALL entity kinds (modules + pages + templates + page-
 * layout bindings). Drives the /edit toolbar's "N pending changes"
 * badge so the count survives a page reload.
 *
 * Pre-v0.2.76 the badge was a local in-memory counter that
 * incremented per successful AI tool result; on reload it reset
 * to 0 even though real changes were live on the chat branch.
 *
 * The count is per-distinct-entity (deduped across multiple
 * snapshots of the same module/page/etc.) — matches the operator's
 * mental model of "things changed on this chat", not "tool calls
 * issued".
 */
/**
 * v0.2.79 — entity ids (not just counts) edited on a chat branch
 * across all snapshot kinds. Drives Stage's cascade-expansion via
 * snapshots.publish_impact_pages: the form action calls this to
 * get {moduleIds, templateIds, pageLayoutIds} on the chat branch,
 * then expands to the union of affected pageIds the generator
 * should re-bake.
 *
 * Sibling of branch_change_count (which returns counts only — used
 * by the toolbar pill).
 */
export const listBranchEditedEntitiesOp = defineOperation({
  name: "chat.branch_edited_entities",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    moduleIds: z.array(z.string()),
    pageIds: z.array(z.string()),
    templateIds: z.array(z.string()),
    /** page_layout_snapshots stores per-page layout overrides; the
     *  affected pageIds are the row's page_id, not a layout id. We
     *  surface them as pageIds (alongside the snapshot pageIds) so
     *  the cascade union covers them. */
    pageLayoutPageIds: z.array(z.string()),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      WITH branch AS (
        SELECT ss.id AS snapshot_id
        FROM site_snapshots ss
        JOIN chat_sessions cs ON cs.chat_branch_id = ss.chat_branch_id
        WHERE cs.id = ${input.chatSessionId}::uuid
      )
      SELECT 'module'::text AS kind, module_id::text AS entity_id
        FROM module_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)
      UNION ALL
      SELECT 'page'::text AS kind, page_id::text AS entity_id
        FROM page_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)
      UNION ALL
      SELECT 'template'::text AS kind, template_id::text AS entity_id
        FROM template_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)
      UNION ALL
      SELECT 'page_layout'::text AS kind, page_id::text AS entity_id
        FROM page_layout_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)
    `)) as unknown as { kind: string; entity_id: string }[];

    const moduleIds = new Set<string>();
    const pageIds = new Set<string>();
    const templateIds = new Set<string>();
    const pageLayoutPageIds = new Set<string>();
    for (const r of rows) {
      if (r.kind === "module") moduleIds.add(r.entity_id);
      else if (r.kind === "page") pageIds.add(r.entity_id);
      else if (r.kind === "template") templateIds.add(r.entity_id);
      else if (r.kind === "page_layout") pageLayoutPageIds.add(r.entity_id);
    }
    return ok({
      moduleIds: [...moduleIds],
      pageIds: [...pageIds],
      templateIds: [...templateIds],
      pageLayoutPageIds: [...pageLayoutPageIds],
    });
  },
});

export const countBranchChangesOp = defineOperation({
  name: "chat.branch_change_count",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    count: z.number().int().nonnegative(),
    byKind: z.object({
      modules: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      templates: z.number().int().nonnegative(),
      pageLayouts: z.number().int().nonnegative(),
      /** v0.4.0 — per-placement content edits on this branch. */
      pageModuleContent: z.number().int().nonnegative(),
    }),
  }),
  handler: async (_ctx, input, tx) => {
    // Single query, five sub-counts. Each kind dedupes by its
    // entity column. site_snapshots scoped to the chat's branch.
    const rows = (await tx.execute(sql`
      WITH branch AS (
        SELECT ss.id AS snapshot_id
        FROM site_snapshots ss
        JOIN chat_sessions cs ON cs.chat_branch_id = ss.chat_branch_id
        WHERE cs.id = ${input.chatSessionId}::uuid
      )
      SELECT
        (SELECT COUNT(DISTINCT module_id)::int   FROM module_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch))   AS modules,
        (SELECT COUNT(DISTINCT page_id)::int     FROM page_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch))     AS pages,
        (SELECT COUNT(DISTINCT template_id)::int FROM template_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)) AS templates,
        (SELECT COUNT(DISTINCT page_id)::int     FROM page_layout_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)) AS page_layouts,
        (SELECT COUNT(DISTINCT page_module_content_id)::int FROM page_module_content_snapshots WHERE site_snapshot_id IN (SELECT snapshot_id FROM branch)) AS page_module_content
    `)) as unknown as {
      modules: number;
      pages: number;
      templates: number;
      page_layouts: number;
      page_module_content: number;
    }[];
    const r = rows[0] ?? {
      modules: 0,
      pages: 0,
      templates: 0,
      page_layouts: 0,
      page_module_content: 0,
    };
    return ok({
      count: r.modules + r.pages + r.templates + r.page_layouts + r.page_module_content,
      byKind: {
        modules: r.modules,
        pages: r.pages,
        templates: r.templates,
        pageLayouts: r.page_layouts,
        pageModuleContent: r.page_module_content,
      },
    });
  },
});

/**
 * v0.5.8 — Active-page list for the /edit picker. Returns one row per
 * page that currently has an open (unpublished) chat session. /edit's
 * page picker uses this to dot pages with pending chats so the
 * operator picks "Resume" instead of "New chat".
 */
export const listActivePagesOp = defineOperation({
  name: "chat.list_active_pages",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    pages: z.array(
      z
        .object({
          pageId: z.string(),
          chatSessionId: z.string(),
          chatTitle: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (page_id)
             page_id::text       AS page_id,
             id::text            AS chat_session_id,
             title               AS chat_title,
             created_at          AS created_at
      FROM chat_sessions
      WHERE page_id IS NOT NULL AND published_at IS NULL AND archived_at IS NULL
      ORDER BY page_id, created_at DESC
    `)) as unknown as {
      page_id: string;
      chat_session_id: string;
      chat_title: string;
      created_at: string | Date;
    }[];
    return ok({
      pages: rows.map((r) => ({
        pageId: r.page_id,
        chatSessionId: r.chat_session_id,
        chatTitle: r.chat_title,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});
