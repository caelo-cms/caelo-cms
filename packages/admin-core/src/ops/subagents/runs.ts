// SPDX-License-Identifier: MPL-2.0

/**
 * P10.5 — subagent_runs CRUD + cost aggregation. The transcript itself
 * lives in chat_messages for the ephemeral session; these ops are
 * metadata + status tracking + the Owner observability surface.
 */

import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

const runRow = z.object({
  id: z.string(),
  parentChatSessionId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  subagentChatSessionId: z.string(),
  batchId: z.string().nullable(),
  role: z.string(),
  task: z.string(),
  status: z.enum(["pending", "running", "completed", "errored", "timed_out", "cancelled"]),
  resultJson: z.unknown().nullable(),
  costMicrocents: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

interface RunDb {
  id: string;
  parent_chat_session_id: string | null;
  parent_message_id: string | null;
  subagent_chat_session_id: string;
  batch_id: string | null;
  role: string;
  task: string;
  status: "pending" | "running" | "completed" | "errored" | "timed_out" | "cancelled";
  result_json: unknown;
  cost_microcents: number | string;
  duration_ms: number;
  error_message: string | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  created_at: string | Date;
}

function rowToOut(r: RunDb): z.infer<typeof runRow> {
  return {
    id: r.id,
    parentChatSessionId: r.parent_chat_session_id,
    parentMessageId: r.parent_message_id,
    subagentChatSessionId: r.subagent_chat_session_id,
    batchId: r.batch_id,
    role: r.role,
    task: r.task,
    status: r.status,
    resultJson:
      typeof r.result_json === "string" ? JSON.parse(r.result_json) : (r.result_json ?? null),
    costMicrocents:
      typeof r.cost_microcents === "string"
        ? Number.parseInt(r.cost_microcents, 10)
        : r.cost_microcents,
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
    startedAt:
      r.started_at === null
        ? null
        : r.started_at instanceof Date
          ? r.started_at.toISOString()
          : String(r.started_at),
    finishedAt:
      r.finished_at === null
        ? null
        : r.finished_at instanceof Date
          ? r.finished_at.toISOString()
          : String(r.finished_at),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export const createPendingSubagentRunOp = defineOperation({
  name: "subagent_runs.create_pending",
  // Called from inside the spawn_subagent tool handler — AI actor.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      parentChatSessionId: z.string().uuid().nullable(),
      parentMessageId: z.string().uuid().nullable(),
      subagentChatSessionId: z.string().uuid(),
      batchId: z.string().uuid().nullable(),
      role: z.string().min(1).max(120),
      task: z.string().min(1).max(8000),
    })
    .strict(),
  output: z.object({ id: z.string() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO subagent_runs (
        parent_chat_session_id, parent_message_id, subagent_chat_session_id,
        batch_id, role, task, status, started_at
      ) VALUES (
        ${input.parentChatSessionId}, ${input.parentMessageId},
        ${input.subagentChatSessionId}::uuid, ${input.batchId},
        ${input.role}, ${input.task}, 'running', now()
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "subagent_runs.create_pending",
        message: "no id returned",
      });
    }
    return ok({ id });
  },
});

export const finishSubagentRunOp = defineOperation({
  name: "subagent_runs.finish",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      id: z.string().uuid(),
      status: z.enum(["completed", "errored", "timed_out", "cancelled"]),
      resultJson: z.unknown().nullable(),
      costMicrocents: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      errorMessage: z.string().nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE subagent_runs
      SET status = ${input.status},
          result_json = ${input.resultJson === null ? null : JSON.stringify(input.resultJson)}::jsonb,
          cost_microcents = ${input.costMicrocents}::bigint,
          duration_ms = ${input.durationMs},
          error_message = ${input.errorMessage},
          finished_at = now()
      WHERE id = ${input.id}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "subagent_runs.finish",
      input,
      succeeded: input.status === "completed",
      entityId: input.id,
      resultSummary: `${input.status} cost_µ¢=${input.costMicrocents}`,
    });
    return ok({});
  },
});

export const listSubagentRunsOp = defineOperation({
  name: "subagent_runs.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      parentChatSessionId: z.string().uuid().nullable().optional(),
      role: z.string().min(1).max(120).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  output: z.object({ runs: z.array(runRow) }),
  handler: async (_ctx, input, tx) => {
    const filters = [];
    if (input.parentChatSessionId !== undefined) {
      if (input.parentChatSessionId === null) {
        filters.push(sql`parent_chat_session_id IS NULL`);
      } else {
        filters.push(sql`parent_chat_session_id = ${input.parentChatSessionId}::uuid`);
      }
    }
    if (input.role) filters.push(sql`role = ${input.role}`);
    const where =
      filters.length === 0
        ? sql``
        : sql`WHERE ${filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`))}`;
    const rows = (await tx.execute(sql`
      SELECT id::text AS id,
             parent_chat_session_id::text AS parent_chat_session_id,
             parent_message_id::text AS parent_message_id,
             subagent_chat_session_id::text AS subagent_chat_session_id,
             batch_id::text AS batch_id,
             role, task, status, result_json,
             cost_microcents, duration_ms, error_message,
             started_at, finished_at, created_at
      FROM subagent_runs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as RunDb[];
    return ok({ runs: rows.map(rowToOut) });
  },
});

export const getSubagentRunOp = defineOperation({
  name: "subagent_runs.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({ run: runRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id,
             parent_chat_session_id::text AS parent_chat_session_id,
             parent_message_id::text AS parent_message_id,
             subagent_chat_session_id::text AS subagent_chat_session_id,
             batch_id::text AS batch_id,
             role, task, status, result_json,
             cost_microcents, duration_ms, error_message,
             started_at, finished_at, created_at
      FROM subagent_runs WHERE id = ${input.id}::uuid LIMIT 1
    `)) as unknown as RunDb[];
    const r = rows[0];
    return ok({ run: r ? rowToOut(r) : null });
  },
});

/**
 * P10.5 #4 — GC ephemeral subagent chat sessions older than a
 * threshold. CASCADE on chat_messages reclaims the transcript bytes;
 * the subagent_chat_session_id FK on subagent_runs has ON DELETE
 * CASCADE, so the metadata row goes with it. For long-term audit
 * retention, raise retentionDays.
 *
 * Owner runs this manually or via a cron later. Default retention 30 days.
 */
export const gcSubagentSessionsOp = defineOperation({
  name: "subagent_runs.gc_old_sessions",
  // Why human-only: hard delete of audit-adjacent data. Owner gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).default(30),
    })
    .strict(),
  output: z.object({ sessionsDeleted: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    const days = input.retentionDays;
    const rows = (await tx.execute(sql`
      DELETE FROM chat_sessions
      WHERE subagent_role IS NOT NULL
        AND id IN (
          SELECT subagent_chat_session_id FROM subagent_runs
          WHERE finished_at IS NOT NULL
            AND finished_at < now() - (${days} || ' days')::interval
        )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const sessionsDeleted = rows.length;
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "subagent_runs.gc_old_sessions",
      input,
      succeeded: true,
      resultSummary: `deleted=${sessionsDeleted} retentionDays=${days}`,
    });
    return ok({ sessionsDeleted });
  },
});

export const aggregateAiCallsForSessionOp = defineOperation({
  name: "ai_calls.aggregate_for_session",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid() }).strict(),
  output: z.object({
    callCount: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT COUNT(*)::int AS call_count,
             COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS cost_microcents,
             COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM ai_calls
      WHERE chat_session_id = ${input.chatSessionId}::uuid
    `)) as unknown as {
      call_count: number;
      cost_microcents: number | string;
      input_tokens: number;
      output_tokens: number;
    }[];
    const r = rows[0];
    if (!r) {
      return ok({ callCount: 0, costMicrocents: 0, inputTokens: 0, outputTokens: 0 });
    }
    return ok({
      callCount: r.call_count,
      costMicrocents:
        typeof r.cost_microcents === "string"
          ? Number.parseInt(r.cost_microcents, 10)
          : r.cost_microcents,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    });
  },
});
