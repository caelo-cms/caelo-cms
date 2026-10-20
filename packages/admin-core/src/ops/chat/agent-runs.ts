// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #664 / #665 — the AI work running in a chat, in one table
 * (`chat_agent_runs`, migration 0255), so the operator can see every agent
 * and stop it from any tab, and so two agents never work in one chat at once.
 *
 *   chat.register_agent_run   — a turn arrives (queued) or a subagent starts.
 *                               Refuses a turn the chat's Stop latch or a
 *                               working external agent rules out.
 *   chat.heartbeat_agent_run  — renew + report whether Stop was requested
 *                               (the runner polls this every second).
 *   chat.finish_agent_run     — the turn / subagent ended.
 *   chat.touch_external_agent — a Power-MCP call: mark the external agent as
 *                               working here, or report that it was stopped.
 *   chat.list_agent_runs      — what is running (one chat, or every chat).
 *   chat.cancel_agents        — Stop (operator only).
 *   chat.allow_external_agent — lift a stopped external agent's block.
 *
 * Every expiry uses the database clock (`now()`), as the turn lease does.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  atMostOneMcpAgent,
  type McpAgentFields,
  mcpAgentInputShape,
  namesMcpAgent,
  sameMcpAgentSql,
} from "./mcp-agent.js";

/** How long a turn / subagent row lives without a heartbeat (crash cleanup). */
export const AGENT_RUN_TTL_MS = 30_000;

/**
 * How long after its last call an external agent still counts as working in
 * a chat. Its tool calls are seconds apart, its thinking between them can
 * take a minute or two; a Live Edit turn must not start in such a gap.
 */
export function externalAgentActiveMs(): number {
  const raw = process.env.CAELO_EXTERNAL_AGENT_ACTIVE_MS;
  if (raw === undefined) return 120_000;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `CAELO_EXTERNAL_AGENT_ACTIVE_MS must be a positive integer of milliseconds, got "${raw}"`,
    );
  }
  return parsed;
}

const runKind = z.enum(["turn", "subagent", "mcp"]);
const runSource = z.enum(["live_edit", "mcp_chat", "power_mcp", "subagent"]);
const runState = z.enum(["queued", "running", "stopped"]);

/** One running (or stopped external) agent, as the UI lists it. */
export const agentRunRow = z.object({
  id: z.string(),
  chatSessionId: z.string(),
  chatTitle: z.string(),
  kind: runKind,
  source: runSource,
  label: z.string(),
  state: runState,
  parentRunId: z.string().nullable(),
  createdAt: z.string(),
  heartbeatAt: z.string(),
  cancelRequested: z.boolean(),
});
export type AgentRunRow = z.infer<typeof agentRunRow>;

const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** Rows the UI shows: live ones, plus stopped external agents (they block until lifted). */
const LIVE_ROW = sql`(r.expires_at > now() OR (r.kind = 'mcp' AND r.state = 'stopped'))`;

async function lockSession(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  chatSessionId: string,
): Promise<{
  agents_stopped_at: string | Date | null;
  agents_stop_epoch: number;
  created_by: string;
} | null> {
  const rows = (await tx.execute(sql`
    SELECT agents_stopped_at, agents_stop_epoch, created_by::text AS created_by FROM chat_sessions
    WHERE id = ${chatSessionId}::uuid FOR UPDATE
  `)) as unknown as {
    agents_stopped_at: string | Date | null;
    agents_stop_epoch: number;
    created_by: string;
  }[];
  return rows[0] ?? null;
}

/**
 * Issue #658 — whether every decided card of this caelo_chat token's paused
 * turn (still waiting for the turn to pick it up) was decided at or after
 * the chat's Stop.
 */
async function approvalDecidedAfterStop(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  chatSessionId: string,
  agent: McpAgentFields,
): Promise<boolean> {
  // The WHOLE batch the resume would claim must postdate the Stop (codex
  // review): one card decided after it must not revive another the
  // operator had approved before stopping.
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS decided,
           count(*) FILTER (
             WHERE decided_at < (SELECT agents_stopped_at FROM chat_sessions
                                 WHERE id = ${chatSessionId}::uuid)
           )::int AS before_stop
    FROM chat_turn_approvals
    WHERE chat_session_id = ${chatSessionId}::uuid AND source = 'mcp_chat'
      AND ${sameMcpAgentSql(agent)} AND status IN ('approved', 'rejected')
  `)) as unknown as { decided: number; before_stop: number }[];
  const r = rows[0];
  return r !== undefined && r.decided > 0 && r.before_stop === 0;
}

// ─── stop epoch (read at request arrival) ─────────────────────────────

export const getAgentStopEpochOp = defineOperation({
  name: "chat.get_agent_stop_epoch",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({ epoch: z.number().int().nonnegative() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT agents_stop_epoch FROM chat_sessions WHERE id = ${input.chatSessionId}::uuid
    `)) as unknown as { agents_stop_epoch: number }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "chat.get_agent_stop_epoch",
        message: `Chat ${input.chatSessionId} does not exist (deleted?). Open the chat list and pick another chat.`,
      });
    }
    return ok({ epoch: row.agents_stop_epoch });
  },
});

/**
 * The refusal text when an external agent works in the chat right now, or
 * null. Checked when a turn registers AND again when it gets the chat (it
 * may have waited while the agent started).
 */
async function workingExternalAgent(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  chatSessionId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT label, heartbeat_at FROM chat_agent_runs
    WHERE chat_session_id = ${chatSessionId}::uuid
      AND kind = 'mcp' AND state = 'running' AND expires_at > now()
    ORDER BY heartbeat_at DESC
    LIMIT 1
  `)) as unknown as { label: string; heartbeat_at: string | Date }[];
  const busy = rows[0];
  if (!busy) return null;
  return (
    `An external agent (${busy.label}) is working in this chat right now (last action ${toIso(busy.heartbeat_at)}). ` +
    "Two agents editing the same pages at once would undo each other's work, so this message was NOT sent. " +
    "Stop the external agent in the 'Agents running' bar above the chat (or wait until it is done), then send the message again."
  );
}

// ─── register ─────────────────────────────────────────────────────────

export const registerAgentRunOp = defineOperation({
  name: "chat.register_agent_run",
  // Runner plumbing driven under the turn's own context (operator, MCP,
  // subagent parent); no AI tool wraps it.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      kind: z.enum(["turn", "subagent"]),
      source: z.enum(["live_edit", "mcp_chat", "subagent"]),
      label: z.string().min(1).max(200),
      /** Set for a subagent: the turn that spawned it. */
      parentRunId: z.string().uuid().optional(),
      /**
       * The chat's Stop count when the request ARRIVED
       * (chat.get_agent_stop_epoch). A Stop since then refuses the turn: it
       * was sent before the operator stopped the chat.
       */
      stopEpochAtArrival: z.number().int().nonnegative().optional(),
      /**
       * A caelo_chat turn: the external agent driving it — its MCP token or
       * its remote connection (#806). If the operator stopped that agent in
       * this chat, its turns are refused too — the Stop must not be bypassed
       * by switching MCP surfaces.
       */
      ...mcpAgentInputShape,
      /**
       * True only for a message the operator sent (or an Approve/Reject they
       * clicked) in the chat itself. Such a turn lifts the chat's Stop latch;
       * every other turn (auto nudges, caelo_chat) is refused while it holds.
       */
      operatorInitiated: z.boolean(),
      /**
       * Issue #658 — a caelo_chat turn resuming its own paused turn with the
       * operator's decision (chat_turn_approvals, 0258). The operator's
       * click on that card is their go-ahead for exactly this work, so a
       * Stop that came BEFORE the click does not refuse it; a Stop after the
       * click does. It never lifts the chat's Stop latch: the Live Edit AI
       * stays stopped.
       */
      resumesDecidedApprovals: z.boolean().optional(),
    })
    .strict()
    .refine(atMostOneMcpAgent.check, { message: atMostOneMcpAgent.message })
    .refine((v) => !v.resumesDecidedApprovals || namesMcpAgent(v), {
      message:
        "resumesDecidedApprovals is only for a caelo_chat turn (mcpTokenId / mcpRemoteConnectionId)",
    })
    .refine((v) => (v.kind === "subagent") === (v.parentRunId !== undefined), {
      message: "parentRunId is required for a subagent and only for a subagent",
    }),
  output: z.discriminatedUnion("registered", [
    z.object({ registered: z.literal(true), runId: z.string() }),
    z.object({
      registered: z.literal(false),
      reason: z.enum(["stopped", "external_agent", "parent_cancelled"]),
      message: z.string(),
    }),
  ]),
  handler: async (ctx, input, tx) => {
    const session = await lockSession(tx, input.chatSessionId);
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.register_agent_run",
        message: `Chat ${input.chatSessionId} does not exist (deleted?). Open the chat list and start or pick another chat.`,
      });
    }
    if (input.kind === "subagent") {
      const parent = (await tx.execute(sql`
        SELECT cancel_requested_at FROM chat_agent_runs WHERE id = ${input.parentRunId}::uuid
      `)) as unknown as { cancel_requested_at: string | Date | null }[];
      if (!parent[0] || parent[0].cancel_requested_at !== null) {
        return ok({
          registered: false as const,
          reason: "parent_cancelled" as const,
          message: "The operator stopped this chat's AI; the subagent was not started.",
        });
      }
    } else {
      // A top-level turn runs as the chat's own operator (Live Edit) or the
      // owner's MCP token (caelo_chat). Checked before anything here writes:
      // nobody else may lift this chat's Stop or start its AI.
      if (session.created_by !== ctx.actorId) {
        return err({
          kind: "HandlerError",
          operation: "chat.register_agent_run",
          message: `Chat ${input.chatSessionId} not found among your chats. Open one of your own chats.`,
        });
      }
      if (
        input.stopEpochAtArrival !== undefined &&
        input.stopEpochAtArrival < session.agents_stop_epoch
      ) {
        return ok({
          registered: false as const,
          reason: "stopped" as const,
          message:
            "Not run: this message reached the server before you pressed Stop, so it was stopped with the rest. Send it again if you still want it.",
        });
      }
      if (namesMcpAgent(input)) {
        const blocked = (await tx.execute(sql`
          SELECT 1 AS blocked FROM chat_agent_runs
          WHERE chat_session_id = ${input.chatSessionId}::uuid
            AND ${sameMcpAgentSql(input)} AND state = 'stopped'
        `)) as unknown as { blocked: number }[];
        if (blocked.length > 0) {
          return ok({
            registered: false as const,
            reason: "stopped" as const,
            message:
              'The operator stopped this external agent in this chat. Nothing runs for it here until they click "Allow again".',
          });
        }
      }
      if (session.agents_stopped_at !== null) {
        // Issue #658 — the operator answered this external agent's question
        // after stopping the chat: its turn continues, and the latch stays
        // for everything else (the Live Edit AI is not restarted).
        const answeredAfterStop =
          input.resumesDecidedApprovals === true &&
          (await approvalDecidedAfterStop(tx, input.chatSessionId, input));
        if (!answeredAfterStop) {
          if (!input.operatorInitiated) {
            return ok({
              registered: false as const,
              reason: "stopped" as const,
              message:
                "The operator stopped the AI in this chat. Nothing runs here again until they send a message themselves.",
            });
          }
          await tx.execute(sql`
            UPDATE chat_sessions SET agents_stopped_at = NULL WHERE id = ${input.chatSessionId}::uuid
          `);
        }
      }
      const busy = await workingExternalAgent(tx, input.chatSessionId);
      if (busy) {
        return ok({
          registered: false as const,
          reason: "external_agent" as const,
          message: busy,
        });
      }
    }
    const rows = (await tx.execute(sql`
      INSERT INTO chat_agent_runs
        (chat_session_id, kind, source, label, state, started_by, parent_run_id, expires_at)
      VALUES (${input.chatSessionId}::uuid, ${input.kind}, ${input.source}, ${input.label},
              ${input.kind === "subagent" ? "running" : "queued"},
              ${ctx.actorId}::uuid, ${input.parentRunId ?? null}::uuid,
              now() + ${AGENT_RUN_TTL_MS}::int * interval '1 millisecond')
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const runId = rows[0]?.id;
    if (!runId) {
      return err({
        kind: "HandlerError",
        operation: "chat.register_agent_run",
        message: "agent run insert returned no row",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.register_agent_run",
      input,
      succeeded: true,
      entityId: runId,
      resultSummary: `${input.kind} (${input.source}) registered in chat ${input.chatSessionId}`,
    });
    return ok({ registered: true as const, runId });
  },
});

// ─── heartbeat ────────────────────────────────────────────────────────

export const heartbeatAgentRunOp = defineOperation({
  name: "chat.heartbeat_agent_run",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      /** Set when the turn got the chat (queued → running). */
      state: z.enum(["running"]).optional(),
    })
    .strict(),
  output: z.object({
    /** True when Stop was requested — or the row is gone (it then cannot be stopped any more). */
    cancelRequested: z.boolean(),
    /**
     * On the queued → running transition of a turn: the refusal text when an
     * external agent started working in the chat while the turn waited.
     */
    externalAgentRefusal: z.string().nullable(),
  }),
  // No audit row: a once-a-second renewal. Register, finish and cancel are
  // the audited transitions (same as the turn lease's renew).
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE chat_agent_runs
      SET heartbeat_at = now(),
          expires_at = now() + ${AGENT_RUN_TTL_MS}::int * interval '1 millisecond',
          state = COALESCE(${input.state ?? null}::text, state)
      WHERE id = ${input.runId}::uuid AND kind <> 'mcp'
      RETURNING cancel_requested_at, kind, chat_session_id::text AS chat_session_id
    `)) as unknown as {
      cancel_requested_at: string | Date | null;
      kind: string;
      chat_session_id: string;
    }[];
    const row = rows[0];
    if (!row) return ok({ cancelRequested: true, externalAgentRefusal: null });
    const externalAgentRefusal =
      input.state === "running" && row.kind === "turn"
        ? await workingExternalAgent(tx, row.chat_session_id)
        : null;
    return ok({ cancelRequested: row.cancel_requested_at !== null, externalAgentRefusal });
  },
});

// ─── finish ───────────────────────────────────────────────────────────

export const finishAgentRunOp = defineOperation({
  name: "chat.finish_agent_run",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({ finished: z.boolean(), cancelled: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM chat_agent_runs WHERE id = ${input.runId}::uuid AND kind <> 'mcp'
      RETURNING cancel_requested_at
    `)) as unknown as { cancel_requested_at: string | Date | null }[];
    const cancelled = rows[0]?.cancel_requested_at != null;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.finish_agent_run",
      input,
      succeeded: true,
      entityId: input.runId,
      resultSummary: rows.length === 0 ? "already gone" : cancelled ? "ended after Stop" : "ended",
    });
    return ok({ finished: rows.length > 0, cancelled });
  },
});

// ─── external agent (Power-MCP) ───────────────────────────────────────

export const touchExternalAgentOp = defineOperation({
  name: "chat.touch_external_agent",
  // Driven by mcp.execute_tool under the token owner's context; no AI tool
  // wraps it (the external agent cannot mark itself un-stopped).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /** The agent: its MCP token or its remote connection (#806) — exactly one. */
      ...mcpAgentInputShape,
      label: z.string().min(1).max(200),
    })
    .strict()
    .refine((v) => namesMcpAgent(v) && atMostOneMcpAgent.check(v), {
      message: "name the external agent by exactly one of mcpTokenId / mcpRemoteConnectionId",
    }),
  output: z.object({
    /** True when the operator stopped this agent in this chat: refuse the call. */
    stopped: z.boolean(),
    runId: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const activeMs = externalAgentActiveMs();
    // One row per (chat, agent): the unique index of whichever id is set
    // (0255 for tokens, 0310 for remote connections) is the conflict target.
    const conflictColumn = sql.raw(
      input.mcpTokenId !== undefined ? "mcp_token_id" : "mcp_remote_connection_id",
    );
    const rows = (await tx.execute(sql`
      INSERT INTO chat_agent_runs
        (chat_session_id, kind, source, label, state, started_by, mcp_token_id,
         mcp_remote_connection_id, expires_at)
      VALUES (${input.chatSessionId}::uuid, 'mcp', 'power_mcp', ${input.label}, 'running',
              ${ctx.actorId}::uuid, ${input.mcpTokenId ?? null}::uuid,
              ${input.mcpRemoteConnectionId ?? null}::uuid,
              now() + ${activeMs}::int * interval '1 millisecond')
      ON CONFLICT (chat_session_id, ${conflictColumn}) DO UPDATE
        SET heartbeat_at = CASE WHEN chat_agent_runs.state = 'stopped'
                                THEN chat_agent_runs.heartbeat_at ELSE now() END,
            expires_at = CASE WHEN chat_agent_runs.state = 'stopped'
                              THEN chat_agent_runs.expires_at ELSE EXCLUDED.expires_at END,
            -- A lapsed row restarts its "working since" clock.
            created_at = CASE WHEN chat_agent_runs.state <> 'stopped'
                                   AND chat_agent_runs.expires_at <= now()
                              THEN now() ELSE chat_agent_runs.created_at END,
            label = EXCLUDED.label
      RETURNING id::text AS id, state
    `)) as unknown as { id: string; state: string }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "chat.touch_external_agent",
        message: "external agent upsert returned no row",
      });
    }
    return ok({ stopped: row.state === "stopped", runId: row.id });
  },
});

// ─── list ─────────────────────────────────────────────────────────────

export const listAgentRunsOp = defineOperation({
  name: "chat.list_agent_runs",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** One chat; omitted = every chat (narrowed by `createdBy`). */
      chatSessionId: z.string().uuid().optional(),
      /** Only chats this actor created (the caller's own chats). */
      createdBy: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ runs: z.array(agentRunRow) }),
  handler: async (_ctx, input, tx) => {
    const chatFilter = input.chatSessionId
      ? sql`AND r.chat_session_id = ${input.chatSessionId}::uuid`
      : sql``;
    const ownerFilter = input.createdBy ? sql`AND s.created_by = ${input.createdBy}::uuid` : sql``;
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id, r.chat_session_id::text AS chat_session_id, s.title AS chat_title,
             r.kind, r.source, r.label, r.state, r.parent_run_id::text AS parent_run_id,
             r.created_at, r.heartbeat_at, r.cancel_requested_at
      FROM chat_agent_runs r
      JOIN chat_sessions s ON s.id = r.chat_session_id
      WHERE ${LIVE_ROW} ${chatFilter} ${ownerFilter}
      ORDER BY r.created_at
      LIMIT 200
    `)) as unknown as {
      id: string;
      chat_session_id: string;
      chat_title: string;
      kind: AgentRunRow["kind"];
      source: AgentRunRow["source"];
      label: string;
      state: AgentRunRow["state"];
      parent_run_id: string | null;
      created_at: string | Date;
      heartbeat_at: string | Date;
      cancel_requested_at: string | Date | null;
    }[];
    return ok({
      runs: rows.map((r) => ({
        id: r.id,
        chatSessionId: r.chat_session_id,
        chatTitle: r.chat_title,
        kind: r.kind,
        source: r.source,
        label: r.label,
        state: r.state,
        parentRunId: r.parent_run_id,
        createdAt: toIso(r.created_at),
        heartbeatAt: toIso(r.heartbeat_at),
        cancelRequested: r.cancel_requested_at !== null,
      })),
    });
  },
});

// ─── cancel (Stop) ────────────────────────────────────────────────────

export const cancelAgentsOp = defineOperation({
  name: "chat.cancel_agents",
  // Why human-only: Stop is the operator's authority over the AI. An AI (or
  // an external agent) stopping work is not a thing this op serves; the AI
  // ends its own turn by answering.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      /**
       * One entry of the running-agents list. Omitted = stop everything in
       * the chat (the composer's Stop button).
       */
      runId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({
    /** Turns / subagents whose runner will stop (abort them locally right away). */
    cancelledRunIds: z.array(z.string()),
    /** External agents now blocked in this chat until "Allow again". */
    stoppedExternalAgents: z.number().int().nonnegative(),
    /** True when the chat's Stop latch is now set (no auto-restart). */
    chatStopped: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    const session = await lockSession(tx, input.chatSessionId);
    if (!session) {
      return err({
        kind: "HandlerError",
        operation: "chat.cancel_agents",
        message: `Chat ${input.chatSessionId} does not exist (deleted?) — nothing to stop.`,
      });
    }
    let scope: "chat" | "turn-only" | "subagent" | "mcp" = "chat";
    if (input.runId) {
      const target = (await tx.execute(sql`
        SELECT kind, state FROM chat_agent_runs
        WHERE id = ${input.runId}::uuid AND chat_session_id = ${input.chatSessionId}::uuid
      `)) as unknown as { kind: AgentRunRow["kind"]; state: AgentRunRow["state"] }[];
      const t = target[0];
      if (!t) {
        return err({
          kind: "HandlerError",
          operation: "chat.cancel_agents",
          message: `Agent run ${input.runId} is not running in this chat any more (it already ended). Reload the list.`,
        });
      }
      // Stopping the RUNNING turn stops the chat: its queue and subagents go
      // with it and nothing restarts. A queued turn or a single subagent is
      // dropped on its own.
      scope =
        t.kind === "mcp"
          ? "mcp"
          : t.kind === "subagent"
            ? "subagent"
            : t.state === "queued"
              ? "turn-only"
              : "chat";
    }

    let cancelled: { id: string }[] = [];
    if (scope === "chat") {
      cancelled = (await tx.execute(sql`
        UPDATE chat_agent_runs
        SET cancel_requested_at = now(), cancel_requested_by = ${ctx.actorId}::uuid
        WHERE chat_session_id = ${input.chatSessionId}::uuid
          AND kind IN ('turn', 'subagent') AND cancel_requested_at IS NULL
          -- Expired rows too: a runner that missed heartbeats may still be
          -- alive, and its next renewal must read the Stop.
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    } else if (scope === "turn-only" || scope === "subagent") {
      cancelled = (await tx.execute(sql`
        UPDATE chat_agent_runs
        SET cancel_requested_at = now(), cancel_requested_by = ${ctx.actorId}::uuid
        WHERE (id = ${input.runId}::uuid OR parent_run_id = ${input.runId}::uuid)
          AND cancel_requested_at IS NULL
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    }

    let stoppedExternal: { id: string }[] = [];
    if (scope === "chat" || scope === "mcp") {
      const only = scope === "mcp" ? sql`AND id = ${input.runId}::uuid` : sql``;
      stoppedExternal = (await tx.execute(sql`
        UPDATE chat_agent_runs
        SET state = 'stopped', expires_at = NULL,
            cancel_requested_at = now(), cancel_requested_by = ${ctx.actorId}::uuid
        WHERE chat_session_id = ${input.chatSessionId}::uuid AND kind = 'mcp'
          AND state = 'running' ${only}
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
    }

    const chatStopped = scope === "chat";
    if (chatStopped) {
      await tx.execute(sql`
        UPDATE chat_sessions
        SET agents_stopped_at = now(), agents_stop_epoch = agents_stop_epoch + 1
        WHERE id = ${input.chatSessionId}::uuid
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.cancel_agents",
      input,
      succeeded: true,
      entityId: input.chatSessionId,
      resultSummary:
        `stopped ${cancelled.length} turn/subagent run(s), ${stoppedExternal.length} external agent(s)` +
        (chatStopped ? "; chat stopped until the operator's next message" : ""),
    });
    return ok({
      cancelledRunIds: cancelled.map((r) => r.id),
      stoppedExternalAgents: stoppedExternal.length,
      chatStopped,
    });
  },
});

// ─── allow external agent again ───────────────────────────────────────

export const allowExternalAgentOp = defineOperation({
  name: "chat.allow_external_agent",
  // Why human-only: lifting a Stop is the operator's decision; the stopped
  // agent must never be able to unblock itself.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid(), runId: z.string().uuid() }).strict(),
  output: z.object({ allowed: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM chat_agent_runs
      WHERE id = ${input.runId}::uuid AND chat_session_id = ${input.chatSessionId}::uuid
        AND kind = 'mcp' AND state = 'stopped'
      RETURNING 1 AS gone
    `)) as unknown as { gone: number }[];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.allow_external_agent",
      input,
      succeeded: rows.length > 0,
      entityId: input.chatSessionId,
      resultSummary: rows.length > 0 ? "external agent allowed again" : "no stopped agent",
    });
    return ok({ allowed: rows.length > 0 });
  },
});
