// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 (remaining gap) — the in-chat approvals a chat turn paused on,
 * and who continues once the operator decided.
 *
 * A gated tool pauses the turn on an AI SDK tool-approval-request (CLAUDE.md
 * §11.A, Plan B). The rule for what the operator's click does depends on
 * whose turn paused (`chat_turn_approvals.source`, migration 0258):
 *
 *  - `live_edit` — the Live Edit chat's own AI asked. Approve/Reject in the
 *    chat resumes that turn (the stream route's `resumeApproval`), also
 *    after a Stop: answering the AI's own question is the operator's
 *    explicit go-ahead for that work. `chat.claim_turn_approvals` records
 *    the decision as the resume turn starts.
 *  - `mcp_chat` — an external agent asked through `caelo_chat`. The Live
 *    Edit card only records the decision (`chat.decide_turn_approval`); it
 *    never starts a Live Edit AI turn. The external agent's own call
 *    (`caelo_chat` / `caelo_await_approval`) reads the state
 *    (`mcp.get_chat_approval_state`) and resumes ITS turn, which claims the
 *    decisions and returns the outcome to the agent.
 *
 * A new message in the chat moves past every open card
 * (`chat.supersede_turn_approvals`): the chat-runner's history repair
 * answers an unanswered gated call as interrupted from then on, so a later
 * click could not apply it anyway.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import type { Permission } from "../../permissions.js";
import { jsonbParam } from "../../sql-helpers.js";
import { approverRefusal } from "../_approver-permission.js";
import { getMcpBridge, resolveMcpToken } from "../security/mcp_tokens.js";
import {
  type ChatApprovalState,
  chatApprovalStateOf,
  type TurnApprovalStatus,
} from "./turn-approval-state.js";

/** Whose turn paused on the approval. */
export const turnApprovalSource = z.enum(["live_edit", "mcp_chat"]);
export type TurnApprovalSource = z.infer<typeof turnApprovalSource>;

const turnApprovalStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "resumed",
  "superseded",
]) satisfies z.ZodType<TurnApprovalStatus>;

/** One approval as the chat UI and the external agent see it. */
export const turnApprovalView = z.object({
  approvalId: z.string(),
  source: turnApprovalSource,
  toolCallId: z.string(),
  toolName: z.string(),
  preview: z.string(),
  requiredPermissions: z.array(z.string()),
  status: turnApprovalStatus,
  /** The decision; null while pending (and for a superseded undecided card). */
  approved: z.boolean().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** When the paused turn picked the decision up and continued. */
  resumedAt: z.string().nullable(),
});
export type TurnApprovalView = z.infer<typeof turnApprovalView>;

/** A decision the resuming turn persists as an SDK tool-approval-response. */
export const turnApprovalDecision = z
  .object({
    approvalId: z.string().min(1).max(200),
    approved: z.boolean(),
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type TurnApprovalDecision = z.infer<typeof turnApprovalDecision>;

interface Row {
  approval_id: string;
  source: TurnApprovalSource;
  tool_call_id: string;
  tool_name: string;
  preview: string;
  required_permissions: string[];
  status: z.infer<typeof turnApprovalStatus>;
  approved: boolean | null;
  reason: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
  resumed_at: string | Date | null;
}

const COLUMNS = sql`approval_id, source, tool_call_id, tool_name, preview, required_permissions,
  status, approved, reason, created_at, decided_at, resumed_at`;

const iso = (v: string | Date | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

function toView(r: Row): TurnApprovalView {
  return {
    approvalId: r.approval_id,
    source: r.source,
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    preview: r.preview,
    requiredPermissions: r.required_permissions ?? [],
    status: r.status,
    approved: r.approved,
    reason: r.reason,
    createdAt: iso(r.created_at) as string,
    decidedAt: iso(r.decided_at),
    resumedAt: iso(r.resumed_at),
  };
}

/**
 * The chat UI's reads and the operator's decision are scoped to the chat's
 * own operator, or someone who manages every chat (`settings.write`, as the
 * running-agents surfaces do). `system` passes (tests, workers). Returns the
 * refusal message, or null.
 */
async function chatAccessRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  chatSessionId: string,
): Promise<string | null> {
  if (ctx.actorKind === "system") return null;
  const rows = (await tx.execute(sql`
    SELECT created_by::text AS created_by FROM chat_sessions WHERE id = ${chatSessionId}::uuid
  `)) as unknown as { created_by: string }[];
  const owner = rows[0]?.created_by;
  if (owner === undefined) {
    return `Chat ${chatSessionId} does not exist (deleted?). Open the chat list and pick another chat.`;
  }
  if (owner === ctx.actorId) return null;
  const manageAll = await approverRefusal(tx, ctx, "chat access", ["settings.write"]);
  return manageAll === null ? null : `Chat ${chatSessionId} not found among your chats.`;
}

// ─── record (the runner, as the turn pauses) ──────────────────────────

export const recordTurnApprovalsOp = defineOperation({
  name: "chat.record_turn_approvals",
  // Why human-only: chat-runner plumbing run under the turn's own human
  // context as it pauses; the AI only ever asks through a gated tool call.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      source: turnApprovalSource,
      /** caelo_chat: the token whose turn paused (only it resumes the turn). */
      mcpTokenId: z.string().uuid().optional(),
      approvals: z
        .array(
          z
            .object({
              approvalId: z.string().min(1).max(200),
              toolCallId: z.string().min(1).max(200),
              toolName: z.string().min(1).max(200),
              preview: z.string().max(20_000),
              requiredPermissions: z.array(z.string().min(1).max(100)).max(20),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict()
    .refine((v) => (v.source === "mcp_chat") === (v.mcpTokenId !== undefined), {
      message: "mcpTokenId is required for an mcp_chat turn and only for one",
    }),
  output: z.object({ recorded: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    let recorded = 0;
    for (const a of input.approvals) {
      const rows = (await tx.execute(sql`
        INSERT INTO chat_turn_approvals
          (chat_session_id, approval_id, source, mcp_token_id, tool_call_id, tool_name, preview,
           required_permissions)
        VALUES (${input.chatSessionId}::uuid, ${a.approvalId}, ${input.source},
                ${input.mcpTokenId ?? null}::uuid, ${a.toolCallId}, ${a.toolName}, ${a.preview},
                ARRAY(SELECT jsonb_array_elements_text(${jsonbParam(a.requiredPermissions)})))
        ON CONFLICT (chat_session_id, approval_id) DO NOTHING
        RETURNING approval_id
      `)) as unknown as { approval_id: string }[];
      recorded += rows.length;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.record_turn_approvals",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `${input.source} turn paused on ${input.approvals.map((a) => a.toolName).join(", ")}`,
    });
    return ok({ recorded });
  },
});

// ─── supersede (a new message moves the chat past open cards) ─────────

export const supersedeTurnApprovalsOp = defineOperation({
  name: "chat.supersede_turn_approvals",
  // Why human-only: chat-runner plumbing, run as a new message's turn starts
  // under that turn's human context; nothing for the AI to call.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({ superseded: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE chat_turn_approvals SET status = 'superseded'
      WHERE chat_session_id = ${input.chatSessionId}::uuid
        AND status IN ('pending', 'approved', 'rejected')
      RETURNING approval_id
    `)) as unknown as { approval_id: string }[];
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "chat.supersede_turn_approvals",
        input,
        succeeded: true,
        entityId: input.chatSessionId,
        resultSummary: `${rows.length} open approval card(s) superseded by a new message`,
      });
    }
    return ok({ superseded: rows.length });
  },
});

/**
 * Plan B — the operator's decision as the transcript's role='tool' row
 * carrying the SDK tool-approval-response ModelMessage (`response_messages`).
 * The resume turn's history replays it verbatim after the paused assistant
 * turn, so the SDK runs the gated tool (approved) or lets the model react
 * (rejected). Same row shape as the runner's `persistApprovalResponse`.
 */
async function insertApprovalResponseRow(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  chatSessionId: string,
  d: TurnApprovalDecision,
): Promise<void> {
  const responseMessages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: d.approvalId,
          approved: d.approved,
          ...(d.reason ? { reason: d.reason } : {}),
        },
      ],
    },
  ];
  await tx.execute(sql`
    INSERT INTO chat_messages (chat_session_id, role, content, status, response_messages)
    VALUES (${chatSessionId}::uuid, 'tool', ${`[approval ${d.approved ? "granted" : "denied"}]`},
            'complete', ${jsonbParam(responseMessages)})
  `);
  await tx.execute(sql`
    UPDATE chat_sessions SET last_active_at = now() WHERE id = ${chatSessionId}::uuid
  `);
}

// ─── claim (the resume turn, inside the chat's turn lease) ────────────

const NOT_OPEN =
  "This approval is no longer open: it was decided already, or a newer message moved the chat on. " +
  "Send a message to continue.";

export const claimTurnApprovalsOp = defineOperation({
  name: "chat.claim_turn_approvals",
  // Why human-only: the resume turn's own plumbing, run under the human
  // context of whoever resumes (the clicking operator, or the MCP token's
  // owner); the AI never resumes a turn.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      source: turnApprovalSource,
      /** live_edit: the operator's click, recorded as this turn starts. */
      decision: turnApprovalDecision.optional(),
      /** mcp_chat: the token resuming its own paused turn. */
      mcpTokenId: z.string().uuid().optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.source === "live_edit"
          ? v.decision !== undefined && v.mcpTokenId === undefined
          : v.decision === undefined && v.mcpTokenId !== undefined,
      {
        message:
          "a live_edit resume carries the operator's decision; an mcp_chat resume carries its token",
      },
    ),
  /** The claimed decisions, already appended to the transcript. */
  output: z.object({ decisions: z.array(turnApprovalDecision) }),
  handler: async (ctx, input, tx) => {
    let decisions: TurnApprovalDecision[];
    if (input.decision) {
      const d = input.decision;
      const rows = (await tx.execute(sql`
        SELECT source, status FROM chat_turn_approvals
        WHERE chat_session_id = ${input.chatSessionId}::uuid AND approval_id = ${d.approvalId}
        FOR UPDATE
      `)) as unknown as { source: TurnApprovalSource; status: string }[];
      const row = rows[0];
      if (row?.status !== "pending") {
        return err({
          kind: "HandlerError",
          operation: "chat.claim_turn_approvals",
          message: NOT_OPEN,
        });
      }
      if (row.source !== "live_edit") {
        return err({
          kind: "HandlerError",
          operation: "chat.claim_turn_approvals",
          message:
            "This approval belongs to the external agent (MCP): decide it on its card. The agent's own call continues its work; the Live Edit AI does not.",
        });
      }
      await tx.execute(sql`
        UPDATE chat_turn_approvals
        SET status = 'resumed', approved = ${d.approved}, reason = ${d.reason ?? null},
            decided_by = ${ctx.actorId}::uuid, decided_at = now(), resumed_at = now()
        WHERE chat_session_id = ${input.chatSessionId}::uuid AND approval_id = ${d.approvalId}
      `);
      decisions = [d];
    } else {
      const rows = (await tx.execute(sql`
        SELECT approval_id, status, approved, reason FROM chat_turn_approvals
        WHERE chat_session_id = ${input.chatSessionId}::uuid AND source = 'mcp_chat'
          AND mcp_token_id = ${input.mcpTokenId ?? null}::uuid
          AND status IN ('pending', 'approved', 'rejected')
        ORDER BY created_at
        FOR UPDATE
      `)) as unknown as {
        approval_id: string;
        status: string;
        approved: boolean | null;
        reason: string | null;
      }[];
      if (rows.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "chat.claim_turn_approvals",
          message: NOT_OPEN,
        });
      }
      if (rows.some((r) => r.status === "pending")) {
        return err({
          kind: "HandlerError",
          operation: "chat.claim_turn_approvals",
          message:
            "approval_pending: the operator has not decided every approval of this turn yet. Wait with caelo_await_approval.",
        });
      }
      await tx.execute(sql`
        UPDATE chat_turn_approvals SET status = 'resumed', resumed_at = now()
        WHERE chat_session_id = ${input.chatSessionId}::uuid AND source = 'mcp_chat'
          AND mcp_token_id = ${input.mcpTokenId ?? null}::uuid
          AND status IN ('approved', 'rejected')
      `);
      decisions = rows.map((r) => ({
        approvalId: r.approval_id,
        approved: r.approved === true,
        ...(r.reason ? { reason: r.reason } : {}),
      }));
    }
    // The transcript rows the resumed turn replays, in the SAME transaction
    // as the claim (codex review): a claim without its response would leave
    // a card "resumed" whose decision never reached the turn, and a retry
    // could not recover it.
    for (const d of decisions) await insertApprovalResponseRow(tx, input.chatSessionId, d);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.claim_turn_approvals",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `${input.source} turn resumed with ${decisions.length} decision(s)`,
    });
    return ok({ decisions });
  },
});

// ─── list (the chat UI's cards + hand-back lines) ─────────────────────

export const listTurnApprovalsOp = defineOperation({
  name: "chat.list_turn_approvals",
  // Why human-only: backs the chat UI's approval cards; the AI sees its own
  // paused calls in its transcript, and list_pending_proposals covers the
  // queued-proposal side.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** How far back decided external-agent cards stay listed (status lines). */
      withinHours: z.number().int().min(1).max(168).default(1),
    })
    .strict(),
  output: z.object({ approvals: z.array(turnApprovalView) }),
  handler: async (ctx, input, tx) => {
    const refused = await chatAccessRefusal(tx as TransactionRunner, ctx, input.chatSessionId);
    if (refused !== null) {
      return err({ kind: "HandlerError", operation: "chat.list_turn_approvals", message: refused });
    }
    const rows = (await tx.execute(sql`
      SELECT ${COLUMNS} FROM chat_turn_approvals
      WHERE chat_session_id = ${input.chatSessionId}::uuid
        AND (status = 'pending'
             OR (source = 'mcp_chat'
                 AND coalesce(decided_at, created_at) > now() - ${input.withinHours}::int * interval '1 hour'))
      ORDER BY created_at
    `)) as unknown as Row[];
    return ok({ approvals: rows.map(toView) });
  },
});

// ─── decide (the operator's click on an external agent's card) ────────

export const decideTurnApprovalOp = defineOperation({
  name: "chat.decide_turn_approval",
  // Why human-only: the operator's click IS the §11.A decision; neither the
  // AI nor the external agent may make it.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      approvalId: z.string().min(1).max(200),
      approved: z.boolean(),
      reason: z.string().max(2000).optional(),
    })
    .strict(),
  output: z.object({ approval: turnApprovalView }),
  handler: async (ctx, input, tx) => {
    const refused = await chatAccessRefusal(tx as TransactionRunner, ctx, input.chatSessionId);
    if (refused !== null) {
      return err({
        kind: "HandlerError",
        operation: "chat.decide_turn_approval",
        message: refused,
      });
    }
    const rows = (await tx.execute(sql`
      SELECT ${COLUMNS} FROM chat_turn_approvals
      WHERE chat_session_id = ${input.chatSessionId}::uuid AND approval_id = ${input.approvalId}
      FOR UPDATE
    `)) as unknown as Row[];
    const row = rows[0];
    if (row?.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "chat.decide_turn_approval",
        message: NOT_OPEN,
      });
    }
    if (row.source !== "mcp_chat") {
      return err({
        kind: "HandlerError",
        operation: "chat.decide_turn_approval",
        message:
          "This is the chat's own AI asking: Approve/Reject on its card resumes the AI's turn in the chat.",
      });
    }
    // #589 — the click alone does not authorise. The external agent's resume
    // applies the change as the token's owner (whose permission the executor
    // checks too); the person deciding must hold it as well.
    if (input.approved && row.required_permissions.length > 0) {
      const refusal = await approverRefusal(
        tx as TransactionRunner,
        ctx,
        row.tool_name,
        row.required_permissions as Permission[],
      );
      if (refusal !== null) {
        return err({
          kind: "HandlerError",
          operation: "chat.decide_turn_approval",
          message: refusal,
        });
      }
    }
    const updated = (await tx.execute(sql`
      UPDATE chat_turn_approvals
      SET status = ${input.approved ? "approved" : "rejected"}, approved = ${input.approved},
          reason = ${input.reason ?? null}, decided_by = ${ctx.actorId}::uuid, decided_at = now()
      WHERE chat_session_id = ${input.chatSessionId}::uuid AND approval_id = ${input.approvalId}
      RETURNING ${COLUMNS}
    `)) as unknown as Row[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.decide_turn_approval",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary: `${input.approved ? "approved" : "rejected"} the external agent's ${row.tool_name}`,
    });
    return ok({ approval: toView(updated[0] as Row) });
  },
});

// ─── the external agent's read (caelo_chat) ───────────────────────────

/** See {@link ChatApprovalState}. */
const chatApprovalState = z.enum(["pending", "decided", "superseded", "none"]);

async function tokenApprovals(
  tx: TransactionRunner,
  chatSessionId: string,
  tokenId: string,
): Promise<Row[]> {
  return (await tx.execute(sql`
    SELECT ${COLUMNS} FROM chat_turn_approvals
    WHERE chat_session_id = ${chatSessionId}::uuid AND source = 'mcp_chat'
      AND mcp_token_id = ${tokenId}::uuid
    ORDER BY created_at DESC
    LIMIT 50
  `)) as unknown as Row[];
}

export const mcpGetChatApprovalStateOp = defineOperation({
  name: "mcp.get_chat_approval_state",
  // Why system-only: the bearer is in the input; the handler resolves it and
  // reads only that token's own approvals. Read-only — nothing here decides.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      plaintextToken: z.string().min(8).max(200),
      chatSessionId: z.string().uuid(),
    })
    .strict(),
  output: z.object({ state: chatApprovalState, approvals: z.array(turnApprovalView) }),
  handler: async (_ctx, input, tx) => {
    const bridge = getMcpBridge();
    if (!bridge) {
      return err({
        kind: "HandlerError",
        operation: "mcp.get_chat_approval_state",
        message: "MCP bridge not configured",
      });
    }
    const resolved = await resolveMcpToken(bridge.adapter, input.plaintextToken);
    if (!resolved.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.get_chat_approval_state",
        message: `auth_error: token ${resolved.error}`,
      });
    }
    const rows = await tokenApprovals(
      tx as TransactionRunner,
      input.chatSessionId,
      resolved.value.tokenId,
    );
    return ok(chatApprovalStateOf(rows.map(toView)));
  },
});
