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
 *
 * #1704 — a replay is only ever the same call. The idempotency key of an
 * MCP call comes from its JSON-RPC id, and a client may send an id again
 * for a different call (one that reconnects with its `Mcp-Session-Id` counts
 * its ids from 0 again). The key's row therefore carries the call it was
 * reserved for ({@link mcpCallDigest}), and binds it for
 * {@link IDEMPOTENCY_WINDOW_MS}: inside the window a repeat with the same
 * digest is the same request (told it runs, or served its result), a key
 * that names another call is refused; after it the key is free again.
 */

import { createHash } from "node:crypto";
import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { callIdentity } from "../../ai/chat-runner/repeat-failure-guard.js";
import { drainTakeoverNotices } from "../../lock-takeover.js";
import { jsonbParam } from "../../sql-helpers.js";
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
 * How long an idempotency key (0455) binds the call it was reserved for,
 * counted from the call's arrival: longer than any tool call runs (image
 * generation takes minutes) plus the client's wait before it resends, so a
 * repeat inside it is a resend of that request. A reservation still pending
 * after it belongs to a call whose process died; a finished one is no
 * longer a resend's answer (#1704). Either way the next call under the key
 * takes it over.
 */
export const IDEMPOTENCY_WINDOW_MS = 15 * 60_000;

/**
 * #1704 — what a call is, for its idempotency key: sha256 of the tool name
 * and the arguments with their object keys sorted, so a resend that
 * serialises the same arguments in another key order is still the same call.
 *
 * @returns 64 hex characters.
 */
export function mcpCallDigest(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(callIdentity(toolName, args)).digest("hex");
}

/** A call's idempotency key and the call it names (see {@link mcpCallDigest}). */
const replayKeyShape = z
  .object({
    toolCallId: z.string().min(1).max(128),
    callDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const agentShape = z
  .object(mcpAgentInputShape)
  .refine((v) => namesMcpAgent(v) && atMostOneMcpAgent.check(v), {
    message: "name the external agent by exactly one of mcpTokenId / mcpRemoteConnectionId",
  });

const approvalHandle = z.object({ proposalId: z.string(), domain: z.string() }).nullable();

/**
 * Which work session the call runs in: an explicit one, or the current one
 * of the caller's remote transport session (0453).
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

/**
 * The spend statement of {@link spentMicrocents}. It runs on every capped
 * MCP tool call, so both arms of the OR must stay index lookups
 * (`ai_calls_chat_session_idx` + `ai_calls_actor_idx`, a BitmapOr — #1291)
 * instead of a scan of every AI call ever made. Exported so the plan test
 * checks this exact statement.
 */
export function spentMicrocentsSql(
  actorId: string,
  chatSessionId: string,
  agent: Pick<McpAgentFields, "mcpTokenId" | "mcpRemoteConnectionId">,
) {
  const credentialCreatedAt =
    agent.mcpTokenId !== undefined
      ? sql`(SELECT created_at FROM mcp_tokens WHERE id = ${agent.mcpTokenId}::uuid)`
      : sql`(SELECT created_at FROM mcp_remote_connections WHERE id = ${agent.mcpRemoteConnectionId ?? null}::uuid)`;
  return sql`
    SELECT COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
    FROM ai_calls
    WHERE chat_session_id = ${chatSessionId}::uuid
       OR (actor_id = ${actorId}::uuid AND created_at >= ${credentialCreatedAt})
  `;
}

/** The install's-AI spend of a capped credential (#741), as mcp.execute_tool always counted it. */
async function spentMicrocents(
  tx: TransactionRunner,
  actorId: string,
  chatSessionId: string,
  agent: McpAgentFields,
): Promise<bigint> {
  const rows = (await tx.execute(
    spentMicrocentsSql(actorId, chatSessionId, agent),
  )) as unknown as Array<{ spent: bigint | string | number }>;
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
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      session: sessionChoice,
      agent: agentShape,
      label: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      /**
       * The call's idempotency key and the call it names: the same call
       * under the key gets its cached first result instead, and the key is
       * reserved before the tool runs so a repeat that arrives meanwhile
       * does not run it again (#1704: only ever the same call).
       */
      replayKey: replayKeyShape.optional(),
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
    /** The same call (session + key + digest) is still running; it is not started again. */
    z.object({ status: z.literal("in_progress"), chatSessionId: z.string() }),
    /**
     * #1704 — the key still binds a DIFFERENT call (`toolName` is that
     * call's tool): nothing runs, nothing is served.
     */
    z.object({ status: z.literal("key_reused"), chatSessionId: z.string(), toolName: z.string() }),
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
    const key = input.replayKey;
    if (key !== undefined) {
      const held = await heldKey(tx, session.id, key.toolCallId);
      if (held) return ok(await answerHeldKey(tx, session.id, key, held));
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
    if (key !== undefined && !(await reserveToolCall(tx, session.id, input.toolName, key))) {
      // Another request reserved the key since the read above (it committed
      // first), or a retry of the call kept under it is running.
      const held = await heldKey(tx, session.id, key.toolCallId);
      return ok(
        held
          ? await answerHeldKey(tx, session.id, key, held)
          : { status: "in_progress" as const, chatSessionId: session.id },
      );
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

/** A key's row while it still binds its call ({@link IDEMPOTENCY_WINDOW_MS}). */
interface HeldKeyRow {
  tool_name: string;
  call_digest: string | null;
  pending: boolean;
  result_ok: boolean;
  result_content: string;
  /** When the call reserved the key (exact, as Postgres text). */
  reserved_at: string;
}

/** The row under `toolCallId` when it was reserved inside the window, else null. */
async function heldKey(
  tx: TransactionRunner,
  chatSessionId: string,
  toolCallId: string,
): Promise<HeldKeyRow | null> {
  const rows = (await tx.execute(sql`
    SELECT tool_name, call_digest, pending, result_ok, result_content,
           created_at::text AS reserved_at
    FROM chat_tool_results
    WHERE chat_session_id = ${chatSessionId}::uuid AND tool_call_id = ${toolCallId}
      AND created_at >= now() - ${IDEMPOTENCY_WINDOW_MS}::int * interval '1 millisecond'
  `)) as unknown as HeldKeyRow[];
  return rows[0] ?? null;
}

/**
 * #1704 — what a call gets for a key that still binds a call: the same call
 * (same digest) is told it runs or is served its result; any other call is
 * refused. A row without a digest (the previous release, the browser chat)
 * never proves the same call.
 */
async function answerHeldKey(
  tx: TransactionRunner,
  chatSessionId: string,
  key: z.infer<typeof replayKeyShape>,
  held: HeldKeyRow,
): Promise<
  | { status: "key_reused"; chatSessionId: string; toolName: string }
  | { status: "in_progress"; chatSessionId: string }
  | {
      status: "cached";
      chatSessionId: string;
      cached: { ok: boolean; content: string };
      approval: { proposalId: string; domain: string } | null;
    }
> {
  if (held.call_digest !== key.callDigest) {
    return { status: "key_reused", chatSessionId, toolName: held.tool_name };
  }
  if (held.pending) return { status: "in_progress", chatSessionId };
  return {
    status: "cached",
    chatSessionId,
    cached: { ok: held.result_ok, content: held.result_content },
    // The first call recorded the hand-off (the cache keeps only ok +
    // content); a replay serves the same handle — that call's own, not one
    // an earlier call under a taken-over key recorded.
    approval: await findMcpHandoffByToolCall(tx, chatSessionId, key.toolCallId, held.reserved_at),
  };
}

/**
 * Reserve the call's idempotency key (0455) for this call — a fresh
 * `pending` row, or one whose window has passed ({@link IDEMPOTENCY_WINDOW_MS}):
 * an abandoned reservation, or a finished call no resend can still be
 * waiting for. A taken-over row forgets everything of the call before it,
 * including a kept call (#1275), unless a retry of that one is running.
 *
 * @returns false when another request holds the key.
 */
async function reserveToolCall(
  tx: TransactionRunner,
  chatSessionId: string,
  toolName: string,
  key: z.infer<typeof replayKeyShape>,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    INSERT INTO chat_tool_results
      (chat_session_id, tool_call_id, tool_name, call_digest, result_ok, result_content, pending)
    VALUES (${chatSessionId}::uuid, ${key.toolCallId}, ${toolName}, ${key.callDigest},
            false, '', true)
    ON CONFLICT (chat_session_id, tool_call_id) DO UPDATE
      SET created_at = now(), tool_name = EXCLUDED.tool_name,
          call_digest = EXCLUDED.call_digest, pending = true, result_ok = false,
          result_content = '', args = NULL, args_actor_id = NULL
      WHERE chat_tool_results.created_at
            < now() - ${IDEMPOTENCY_WINDOW_MS}::int * interval '1 millisecond'
        AND chat_tool_results.retry_claimed_at IS NULL
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

/**
 * #1591 — the summary a hand-off records for a queued proposal's result:
 * the first sentence after "Queued proposal <id>:" (the canonical
 * "<summary>. <how it is approved>" shape the chat's card reads too), or of
 * a bespoke flow's own wording. The rest asks for the approval ("Not applied
 * yet — the Owner approves it at …"), and the hand-off shows the summary
 * next to the DECIDED outcome, where those words are no longer true. A
 * period inside an address (`example.com`) does not end the sentence.
 */
export function queuedProposalSummary(content: string): string {
  const line = QUEUED_PROPOSAL_RE.exec(content)?.[2] ?? content.split("\n")[0] ?? "";
  const end = line.search(/\.(\s|$)/);
  return (end === -1 ? line : line.slice(0, end)).trim();
}

export const mcpFinishToolCallOp = defineOperation({
  name: "mcp.finish_tool_call",
  // Why human-only: the after-half of mcp.begin_tool_call (same reason).
  actorScope: ["human"],
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      agent: agentShape,
      label: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      toolCallId: z.string().min(1).max(128),
      /**
       * Cache the result under `toolCallId`: a caller-supplied key can
       * repeat, and a kept call (`args`) is addressed by it.
       */
      cache: z.boolean(),
      /** #1704 — the call the cached row is for ({@link mcpCallDigest}). */
      callDigest: replayKeyShape.shape.callDigest,
      /**
       * #1275 — the arguments of a failed call kept for `retry_tool_call`
       * (`_retry-keep.ts` decides), kept for the calling actor only
       * (`args_actor_id`, RLS), as `chat.cache_tool_result` keeps them.
       */
      args: z.record(z.string(), z.unknown()).optional(),
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
      // The reservation mcp.begin_tool_call made becomes the result — only
      // this call's own: a key another call took over meanwhile (this one
      // outran the window) keeps that call's row.
      await tx.execute(sql`
        INSERT INTO chat_tool_results
          (chat_session_id, tool_call_id, tool_name, call_digest, result_ok, result_content,
           args, args_actor_id)
        VALUES (${input.chatSessionId}::uuid, ${input.toolCallId}, ${input.toolName},
                ${input.callDigest}, ${input.result.ok}, ${input.result.content},
                ${jsonbParam(input.args)}, ${input.args !== undefined ? ctx.actorId : null}::uuid)
        ON CONFLICT (chat_session_id, tool_call_id) DO UPDATE
          SET result_ok = EXCLUDED.result_ok, result_content = EXCLUDED.result_content,
              args = EXCLUDED.args, args_actor_id = EXCLUDED.args_actor_id,
              pending = false
          WHERE chat_tool_results.pending
            AND chat_tool_results.call_digest = EXCLUDED.call_digest
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
    summary: queuedProposalSummary(input.result.content),
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
 * connect). Runs as the connection's user; RLS (0453) keeps it to their
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

/**
 * #1306 — remember the work session a remote connection opened without a
 * transport session, so a later call that names no session can be told
 * which one it opened (see {@link readUnboundWorkSession}). The newest open
 * wins. Runs as the connection's user; RLS (0481) keeps it to their own
 * connection.
 */
export async function rememberUnboundWorkSession(
  tx: TransactionRunner,
  connectionId: string,
  chatSessionId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO mcp_unbound_work_sessions (connection_id, chat_session_id)
    VALUES (${connectionId}::uuid, ${chatSessionId}::uuid)
    ON CONFLICT (connection_id) DO UPDATE
      SET chat_session_id = EXCLUDED.chat_session_id, opened_at = now()
  `);
}

/**
 * The work session the connection last opened without a transport session,
 * or null when it never did (within {@link TRANSPORT_SESSION_TTL_DAYS} days).
 */
export async function readUnboundWorkSession(
  tx: TransactionRunner,
  connectionId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT chat_session_id::text AS chat_session_id
    FROM mcp_unbound_work_sessions
    WHERE connection_id = ${connectionId}::uuid
      AND opened_at > now() - ${TRANSPORT_SESSION_TTL_DAYS}::int * interval '1 day'
  `)) as unknown as { chat_session_id: string }[];
  return rows[0]?.chat_session_id ?? null;
}
