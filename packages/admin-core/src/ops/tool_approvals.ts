// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W5 — `tool_approvals.{queue, read_for_execute, mark_result,
 * reject_proposal, list_pending}`. Backs the `needsApproval` predicate
 * on `ToolDefinitionWithHandler`: when a tool's predicate returns
 * true the dispatcher persists a row here, returns the canonical
 * "Queued proposal <uuid>:" content so ChatPanel renders the inline
 * Approve / Reject card, and the route handler at
 * /security/tool-approvals/pending dispatches the tool when the
 * Owner clicks Approve.
 *
 * Two-op execute: the route handler can't dispatch a tool from
 * inside a Query API handler (the registry isn't reachable), so the
 * route claims the row via `read_for_execute` (atomic
 * pending → applied transition + returns args), then dispatches via
 * `createDefaultToolRegistry()`, then writes the dispatch result back
 * via `mark_result`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

// ─── queue ───────────────────────────────────────────────────────────

const toolApprovalQueueInput = z
  .object({
    toolName: z.string().min(1).max(120),
    args: z.record(z.string(), z.unknown()),
    preview: z.record(z.string(), z.unknown()),
    chatSessionId: z.string().uuid().optional(),
  })
  .strict();

export const queueToolApprovalOp = defineOperation({
  name: "tool_approvals.queue",
  // CLAUDE.md §11A: AI proposes, human approves. AI must be able to
  // queue (it's the proposing actor); human + system retain it for
  // direct queueing too.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: toolApprovalQueueInput,
  output: z.object({ proposalId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO tool_approval_actions
        (tool_name, args, preview, chat_session_id, proposed_by)
      VALUES
        (${input.toolName},
         ${JSON.stringify(input.args)}::jsonb,
         ${JSON.stringify(input.preview)}::jsonb,
         ${input.chatSessionId === undefined ? null : sql`${input.chatSessionId}::uuid`},
         ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "tool_approvals.queue",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "tool_approvals.queue",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `queued ${input.toolName}`,
    });
    return ok({ proposalId: id });
  },
});

// ─── read_for_execute (claim) ────────────────────────────────────────

export const readToolApprovalForExecuteOp = defineOperation({
  name: "tool_approvals.read_for_execute",
  // Why human-only: the actual dispatch happens in the route handler
  // running with the operator's session; AI cannot self-approve its
  // own queued proposals.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
    chatSessionId: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    // Atomic claim: only transitions if currently 'pending', so
    // double-click doesn't double-execute. Returns the row content
    // for the route handler to dispatch.
    const rows = (await tx.execute(sql`
      UPDATE tool_approval_actions
      SET status = 'applied',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
      RETURNING tool_name AS tool_name,
                args AS args,
                chat_session_id::text AS chat_session_id
    `)) as unknown as Array<{
      tool_name: string;
      args: unknown;
      chat_session_id: string | null;
    }>;
    const row = rows[0];
    if (!row) {
      // Either it doesn't exist or it was already approved/rejected.
      const existsRows = (await tx.execute(sql`
        SELECT status FROM tool_approval_actions WHERE id = ${input.proposalId}::uuid LIMIT 1
      `)) as unknown as Array<{ status: string }>;
      const status = existsRows[0]?.status;
      return err({
        kind: "HandlerError",
        operation: "tool_approvals.read_for_execute",
        message: status ? `proposal already ${status}` : `proposal ${input.proposalId} not found`,
      });
    }
    const args = (typeof row.args === "string" ? JSON.parse(row.args) : row.args) as Record<
      string,
      unknown
    >;
    return ok({
      toolName: row.tool_name,
      args,
      chatSessionId: row.chat_session_id,
    });
  },
});

// ─── mark_result ─────────────────────────────────────────────────────

export const markToolApprovalResultOp = defineOperation({
  name: "tool_approvals.mark_result",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      ok: z.boolean(),
      summary: z.string().max(2000),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE tool_approval_actions
      SET result_ok = ${input.ok},
          result_summary = ${input.summary}
      WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "tool_approvals.mark_result",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.summary.slice(0, 200),
    });
    return ok({});
  },
});

// ─── reject_proposal ─────────────────────────────────────────────────

export const rejectToolApprovalOp = defineOperation({
  name: "tool_approvals.reject_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE tool_approval_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "tool_approvals.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

// ─── list_pending ────────────────────────────────────────────────────

const toolApprovalRowSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  chatSessionId: z.string().nullable(),
  proposedBy: z.string(),
  status: z.enum(["pending", "applied", "rejected", "superseded"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  resultOk: z.boolean().nullable(),
  resultSummary: z.string().nullable(),
});

export const listPendingToolApprovalsOp = defineOperation({
  name: "tool_approvals.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(200).optional(),
      includeDecided: z.boolean().optional(),
      chatSessionId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ proposals: z.array(toolApprovalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const limit = input.limit ?? 50;
    const statusFilter = input.includeDecided ? sql`` : sql`AND status = 'pending'`;
    const chatFilter = input.chatSessionId
      ? sql`AND chat_session_id = ${input.chatSessionId}::uuid`
      : sql``;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, tool_name, args, preview,
             chat_session_id::text AS chat_session_id,
             proposed_by::text AS proposed_by,
             status, created_at,
             decided_at, decided_by::text AS decided_by,
             decision_reason, result_ok, result_summary
      FROM tool_approval_actions
      WHERE 1=1 ${statusFilter} ${chatFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{
      id: string;
      tool_name: string;
      args: unknown;
      preview: unknown;
      chat_session_id: string | null;
      proposed_by: string;
      status: "pending" | "applied" | "rejected" | "superseded";
      created_at: string | Date;
      decided_at: string | Date | null;
      decided_by: string | null;
      decision_reason: string | null;
      result_ok: boolean | null;
      result_summary: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        toolName: r.tool_name,
        args: (typeof r.args === "string" ? JSON.parse(r.args) : r.args) as Record<string, unknown>,
        preview: (typeof r.preview === "string" ? JSON.parse(r.preview) : r.preview) as Record<
          string,
          unknown
        >,
        chatSessionId: r.chat_session_id,
        proposedBy: r.proposed_by,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        decidedAt: r.decided_at
          ? r.decided_at instanceof Date
            ? r.decided_at.toISOString()
            : String(r.decided_at)
          : null,
        decidedBy: r.decided_by,
        decisionReason: r.decision_reason,
        resultOk: r.result_ok,
        resultSummary: r.result_summary,
      })),
    });
  },
});
