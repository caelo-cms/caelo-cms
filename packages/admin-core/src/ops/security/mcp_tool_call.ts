// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — the bookkeeping around one Power-MCP tool call, in one
 * transaction before the tool and one after it.
 *
 * A remote write call used to run ~12 transactions and 85–95 database
 * round trips around the tool itself: the session row, presence twice, a
 * turn lease taken and released, the result cache, the takeover notices,
 * `last_active_at`, and an empty approval hand-off. With five agents that
 * is what kept the pool busy while the database idled. Everything the call
 * needs before the tool runs is read and written here in ONE transaction
 * (`mcp.begin_tool_call`); everything it records afterwards in ONE more
 * (`mcp.finish_tool_call`).
 *
 * Writes to rows other callers also touch are only made when they are
 * stale: the agent's presence row and the chat's `last_active_at` move at
 * most every {@link STALE_AFTER_MS}. Every call used to update both, which
 * queued each snapshot write (`FOR SHARE` on chat_sessions, chat-write-guard)
 * behind the next call's `UPDATE`.
 *
 * There is no per-chat write slot: conflicts between concurrent writes are
 * caught per entity, against the version the call read (the snapshot this
 * op returns; tool-call-version.ts, locks.ts).
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { drainTakeoverNotices } from "../../lock-takeover.js";
import { externalAgentActiveMs } from "../chat/agent-runs.js";
import {
  atMostOneMcpAgent,
  type McpAgentFields,
  mcpAgentInputShape,
  namesMcpAgent,
  sameMcpAgentSql,
} from "../chat/mcp-agent.js";
import { findMcpHandoffByToolCall, recordMcpHandoff } from "../mcp_approval_handoffs.js";

/** How old the presence row and `last_active_at` may get before a call renews them. */
export const STALE_AFTER_MS = 30_000;

/**
 * How long a reserved idempotency key (0406) holds before a repeat may take
 * it over: longer than any tool call runs (image generation takes minutes),
 * so only a call whose process died leaves one behind that long.
 */
export const RESERVATION_TIMEOUT_MS = 15 * 60_000;

const agentShape = z
  .object(mcpAgentInputShape)
  .refine((v) => namesMcpAgent(v) && atMostOneMcpAgent.check(v), {
    message: "name the external agent by exactly one of mcpTokenId / mcpRemoteConnectionId",
  });

const approvalHandle = z.object({ proposalId: z.string(), domain: z.string() }).nullable();

/**
 * Which work session the call runs in: an explicit one, or the current one
 * of the caller's remote transport session (0404).
 */
const sessionChoice = z.union([
  z.object({ chatSessionId: z.string().uuid() }).strict(),
  z
    .object({
      remoteConnectionId: z.string().uuid(),
      transportSessionId: z.string().min(16).max(128),
    })
    .strict(),
]);

/** What the session row says about writing into it. */
interface SessionRow {
  id: string;
  chat_branch_id: string;
  closed: boolean;
}

async function resolveSession(
  tx: TransactionRunner,
  actorId: string,
  choice: z.infer<typeof sessionChoice>,
): Promise<SessionRow | "no_session" | "not_found"> {
  let chatSessionId: string;
  if ("chatSessionId" in choice) {
    chatSessionId = choice.chatSessionId;
  } else {
    const bound = (await tx.execute(sql`
      SELECT chat_session_id::text AS id FROM mcp_transport_sessions
      WHERE connection_id = ${choice.remoteConnectionId}::uuid
        AND transport_session_id = ${choice.transportSessionId}
    `)) as unknown as { id: string }[];
    const id = bound[0]?.id;
    if (!id) return "no_session";
    chatSessionId = id;
  }
  // The owner filter is the access rule: another user's chat reads as not
  // found, so a credential can never write into a chat it does not own.
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, chat_branch_id::text AS chat_branch_id,
           (published_at IS NOT NULL OR archived_at IS NOT NULL) AS closed
    FROM chat_sessions
    WHERE id = ${chatSessionId}::uuid AND created_by = ${actorId}::uuid
  `)) as unknown as SessionRow[];
  return rows[0] ?? "not_found";
}

/**
 * The agent's presence in the chat: refused when the operator stopped it,
 * renewed only when stale. Same row and expiry as `chat.touch_external_agent`.
 *
 * @returns true when the operator stopped this agent in the chat.
 */
async function markPresent(
  tx: TransactionRunner,
  actorId: string,
  chatSessionId: string,
  agent: McpAgentFields,
  label: string,
): Promise<boolean> {
  const current = (await tx.execute(sql`
    SELECT state, (heartbeat_at > now() - ${STALE_AFTER_MS}::int * interval '1 millisecond'
                   AND expires_at > now()) AS fresh
    FROM chat_agent_runs
    WHERE chat_session_id = ${chatSessionId}::uuid AND kind = 'mcp' AND ${sameMcpAgentSql(agent)}
  `)) as unknown as { state: string; fresh: boolean | null }[];
  const row = current[0];
  if (row?.state === "stopped") return true;
  if (row?.fresh === true) return false;
  await upsertPresence(tx, actorId, chatSessionId, agent, label);
  return false;
}

/** Insert or renew the presence row (the 0255 / 0319 unique index is the target). */
async function upsertPresence(
  tx: TransactionRunner,
  actorId: string,
  chatSessionId: string,
  agent: McpAgentFields,
  label: string,
): Promise<void> {
  const conflictColumn = sql.raw(
    agent.mcpTokenId !== undefined ? "mcp_token_id" : "mcp_remote_connection_id",
  );
  await tx.execute(sql`
    INSERT INTO chat_agent_runs
      (chat_session_id, kind, source, label, state, started_by, mcp_token_id,
       mcp_remote_connection_id, expires_at)
    VALUES (${chatSessionId}::uuid, 'mcp', 'power_mcp', ${label}, 'running',
            ${actorId}::uuid, ${agent.mcpTokenId ?? null}::uuid,
            ${agent.mcpRemoteConnectionId ?? null}::uuid,
            now() + ${externalAgentActiveMs()}::int * interval '1 millisecond')
    ON CONFLICT (chat_session_id, ${conflictColumn}) DO UPDATE
      SET heartbeat_at = now(),
          expires_at = EXCLUDED.expires_at,
          created_at = CASE WHEN chat_agent_runs.expires_at <= now()
                            THEN now() ELSE chat_agent_runs.created_at END,
          label = EXCLUDED.label
      WHERE chat_agent_runs.state <> 'stopped'
  `);
}

/** The install's-AI spend of a capped credential (#741), as mcp.execute_tool always counted it. */
async function spentMicrocents(
  tx: TransactionRunner,
  actorId: string,
  chatSessionId: string,
  agent: McpAgentFields,
): Promise<bigint> {
  const credentialCreatedAt =
    agent.mcpTokenId !== undefined
      ? sql`(SELECT created_at FROM mcp_tokens WHERE id = ${agent.mcpTokenId}::uuid)`
      : sql`(SELECT created_at FROM mcp_remote_connections WHERE id = ${agent.mcpRemoteConnectionId ?? null}::uuid)`;
  const rows = (await tx.execute(sql`
    SELECT COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
    FROM ai_calls
    WHERE chat_session_id = ${chatSessionId}::uuid
       OR (actor_id = ${actorId}::uuid AND created_at >= ${credentialCreatedAt})
  `)) as unknown as Array<{ spent: bigint | string | number }>;
  const raw = rows[0]?.spent ?? 0;
  // Compared as bigint — a Number round-trip loses precision past 2^53 µ¢
  // and could let a capped credential slip through (PR #379 review).
  return typeof raw === "bigint" ? raw : BigInt(typeof raw === "string" ? raw : Math.trunc(raw));
}

export const mcpBeginToolCallOp = defineOperation({
  name: "mcp.begin_tool_call",
  // Why human-only: runs as the credential's own user inside mcp.execute_tool
  // (the external agent's calls are that user's); no AI tool wraps it, and
  // the agent must not be able to mark itself present or un-stopped.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      session: sessionChoice,
      agent: agentShape,
      label: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      /**
       * Caller-supplied idempotency key: a cached first result is returned
       * instead, and the key is reserved before the tool runs so a repeat
       * that arrives meanwhile does not run it again.
       */
      toolCallId: z.string().min(1).max(128).optional(),
      /** Set when the tool spends the install's AI under a capped credential. */
      costCapMicrocents: z.number().int().nonnegative().optional(),
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("no_session") }),
    z.object({ status: z.literal("not_found") }),
    z.object({ status: z.literal("closed"), chatSessionId: z.string() }),
    z.object({ status: z.literal("stopped"), chatSessionId: z.string() }),
    z.object({
      status: z.literal("cached"),
      chatSessionId: z.string(),
      cached: z.object({ ok: z.boolean(), content: z.string() }),
      approval: approvalHandle,
    }),
    z.object({ status: z.literal("cost_capped"), chatSessionId: z.string(), spent: z.string() }),
    /** The same call (session + toolCallId) is still running; it is not started again. */
    z.object({ status: z.literal("in_progress"), chatSessionId: z.string() }),
    z.object({
      status: z.literal("ready"),
      chatSessionId: z.string(),
      chatBranchId: z.string(),
      /** `pg_current_snapshot()` of this transaction: the version the call reads. */
      snapshot: z.string(),
    }),
  ]),
  handler: async (ctx, input, tx) => {
    const session = await resolveSession(tx, ctx.actorId, input.session);
    if (session === "no_session" || session === "not_found") return ok({ status: session });
    if (session.closed) return ok({ status: "closed" as const, chatSessionId: session.id });
    if (await markPresent(tx, ctx.actorId, session.id, input.agent, input.label)) {
      return ok({ status: "stopped" as const, chatSessionId: session.id });
    }
    if (input.toolCallId !== undefined) {
      const rows = (await tx.execute(sql`
        SELECT result_ok, result_content, pending,
               (created_at < now() - ${RESERVATION_TIMEOUT_MS}::int * interval '1 millisecond')
                 AS abandoned
        FROM chat_tool_results
        WHERE chat_session_id = ${session.id}::uuid AND tool_call_id = ${input.toolCallId}
      `)) as unknown as {
        result_ok: boolean;
        result_content: string;
        pending: boolean;
        abandoned: boolean;
      }[];
      const hit = rows[0];
      if (hit?.pending === true && !hit.abandoned) {
        return ok({ status: "in_progress" as const, chatSessionId: session.id });
      }
      if (hit && !hit.pending) {
        return ok({
          status: "cached" as const,
          chatSessionId: session.id,
          cached: { ok: hit.result_ok, content: hit.result_content },
          // The first call recorded the hand-off (the cache keeps only
          // ok + content); a replay serves the same handle.
          approval: await findMcpHandoffByToolCall(tx, session.id, input.toolCallId),
        });
      }
    }
    if (input.costCapMicrocents !== undefined) {
      const spent = await spentMicrocents(tx, ctx.actorId, session.id, input.agent);
      if (spent >= BigInt(input.costCapMicrocents)) {
        return ok({
          status: "cost_capped" as const,
          chatSessionId: session.id,
          spent: spent.toString(),
        });
      }
    }
    if (input.toolCallId !== undefined && !(await reserveToolCall(tx, session.id, input))) {
      return ok({ status: "in_progress" as const, chatSessionId: session.id });
    }
    // Issue #620 — MCP work is activity in this session (the chat list
    // sorts by it); renewed only when stale (see the file header).
    await tx.execute(sql`
      UPDATE chat_sessions SET last_active_at = now()
      WHERE id = ${session.id}::uuid
        AND last_active_at < now() - ${STALE_AFTER_MS}::int * interval '1 millisecond'
    `);
    const snap = (await tx.execute(
      sql`SELECT pg_current_snapshot()::text AS snapshot`,
    )) as unknown as { snapshot: string }[];
    const snapshot = snap[0]?.snapshot;
    if (!snapshot) {
      return err({
        kind: "HandlerError",
        operation: "mcp.begin_tool_call",
        message: "pg_current_snapshot() returned no row",
      });
    }
    return ok({
      status: "ready" as const,
      chatSessionId: session.id,
      chatBranchId: session.chat_branch_id,
      snapshot,
    });
  },
});

/**
 * Reserve the call's idempotency key (0406) — a fresh `pending` row, or one
 * whose call was abandoned ({@link RESERVATION_TIMEOUT_MS}).
 *
 * @returns false when another request holds it: the same call is running.
 */
async function reserveToolCall(
  tx: TransactionRunner,
  chatSessionId: string,
  input: { toolCallId?: string | undefined; toolName: string },
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    INSERT INTO chat_tool_results
      (chat_session_id, tool_call_id, tool_name, result_ok, result_content, pending)
    VALUES (${chatSessionId}::uuid, ${input.toolCallId ?? null}, ${input.toolName}, false, '', true)
    ON CONFLICT (chat_session_id, tool_call_id) DO UPDATE
      SET created_at = now(), tool_name = EXCLUDED.tool_name
      WHERE chat_tool_results.pending
        AND chat_tool_results.created_at
            < now() - ${RESERVATION_TIMEOUT_MS}::int * interval '1 millisecond'
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length === 1;
}

/**
 * The canonical shape gated tools' queued results start with (enforced by
 * propose-content-shape.test.ts); the bespoke skill / site-memory flows
 * carry `queuedProposalId` instead.
 */
const QUEUED_PROPOSAL_RE =
  /^Queued proposal ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\s*([^\n]*)/;

export const mcpFinishToolCallOp = defineOperation({
  name: "mcp.finish_tool_call",
  // Why human-only: the after-half of mcp.begin_tool_call (same reason).
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      agent: agentShape,
      label: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      toolCallId: z.string().min(1).max(128),
      /** Cache the result under `toolCallId` (only a caller-supplied key can repeat). */
      cache: z.boolean(),
      result: z
        .object({
          ok: z.boolean(),
          content: z.string(),
          queuedProposalId: z.string().uuid().optional(),
        })
        .strict(),
    })
    .strict(),
  output: z.object({
    /** Issue #620 — lock takeovers this chat should hear about, appended to the result. */
    notes: z.array(z.string()),
    /** Issue #658 — set when the call queued an approval-gated proposal. */
    approval: approvalHandle,
  }),
  handler: async (ctx, input, tx) => {
    if (input.cache) {
      // The reservation mcp.begin_tool_call made becomes the result.
      await tx.execute(sql`
        INSERT INTO chat_tool_results
          (chat_session_id, tool_call_id, tool_name, result_ok, result_content)
        VALUES (${input.chatSessionId}::uuid, ${input.toolCallId}, ${input.toolName},
                ${input.result.ok}, ${input.result.content})
        ON CONFLICT (chat_session_id, tool_call_id) DO UPDATE
          SET result_ok = EXCLUDED.result_ok, result_content = EXCLUDED.result_content,
              pending = false
          WHERE chat_tool_results.pending
      `);
    }
    const approval = await handOffQueuedProposal(tx, ctx.actorId, input);
    const notes = await drainTakeoverNotices(tx, input.chatSessionId);
    // A long call keeps the agent listed as working until it returns: the
    // window counts from the call's end, renewed when stale.
    await markPresent(tx, ctx.actorId, input.chatSessionId, input.agent, input.label);
    return ok({ notes, approval });
  },
});

/**
 * Issue #658 — when a gated tool queued a proposal, record that the
 * EXTERNAL agent asked for it (so the Live Edit card that renders it hands
 * the decision back here instead of continuing its own AI) and return the
 * handle the MCP server waits on. Idempotent across cached replays.
 */
async function handOffQueuedProposal(
  tx: TransactionRunner,
  requestedBy: string,
  input: {
    chatSessionId: string;
    toolName: string;
    toolCallId: string;
    result: { ok: boolean; content: string; queuedProposalId?: string | undefined };
  },
): Promise<{ proposalId: string; domain: string } | null> {
  if (!input.result.ok) return null;
  const m = QUEUED_PROPOSAL_RE.exec(input.result.content);
  const proposalId = input.result.queuedProposalId ?? m?.[1];
  if (!proposalId) return null;
  const recorded = await recordMcpHandoff(tx, {
    proposalId,
    chatSessionId: input.chatSessionId,
    requestedBy,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    summary: m?.[2] ?? input.result.content.split("\n")[0] ?? "",
  });
  if (!recorded) {
    // Every gated tool queues into a source pending_proposals.list knows;
    // a miss is drift between the two (CLAUDE.md §2 — say so loudly).
    console.error("[mcp.finish_tool_call] queued proposal in no known pending source", {
      proposalId,
      toolName: input.toolName,
    });
    return null;
  }
  return { proposalId, domain: recorded.domain };
}

/**
 * Bind the caller's remote transport session (`Mcp-Session-Id`) to a work
 * session, so its later calls without an explicit `workSessionId` land
 * there. Mappings not rebound for {@link TRANSPORT_SESSION_TTL_DAYS} days
 * are dropped on the way (a client opens a new transport session per
 * connect). Runs as the connection's user; RLS (0404) keeps it to their
 * own connection.
 */
export async function bindTransportSession(
  tx: TransactionRunner,
  connectionId: string,
  transportSessionId: string,
  chatSessionId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM mcp_transport_sessions
    WHERE connection_id = ${connectionId}::uuid
      AND bound_at < now() - ${TRANSPORT_SESSION_TTL_DAYS}::int * interval '1 day'
  `);
  await tx.execute(sql`
    INSERT INTO mcp_transport_sessions (connection_id, transport_session_id, chat_session_id)
    VALUES (${connectionId}::uuid, ${transportSessionId}, ${chatSessionId}::uuid)
    ON CONFLICT (connection_id, transport_session_id) DO UPDATE
      SET chat_session_id = EXCLUDED.chat_session_id, bound_at = now()
  `);
}

/** How long an unused transport-session mapping is kept. */
export const TRANSPORT_SESSION_TTL_DAYS = 30;
