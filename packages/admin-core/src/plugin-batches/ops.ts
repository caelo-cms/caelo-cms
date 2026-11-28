// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — the ops of plugin batch runs.
 *
 *   plugin_batches.start     a person or the AI starts an `operator` batch
 *   plugin_batches.enqueue   a trigger (activation, Stage, schedule) queues one
 *   plugin_batches.list      the runs, newest first
 *   plugin_batches.stop      ends a run that has not ended
 *   plugin_batches.claim     the job's order: the run moves to running
 *   plugin_batches.finish    the job's end: completed or failed
 *   plugin_batches.get       one run (the job's every report checks it)
 *   plugin_batches.unstarted queued runs without a job (the tick's backstop)
 *
 * A start checks what the plugin declares and was granted; the run itself
 * is started after the commit (`plugin_batch` reporting job), and a start
 * lost on the way is picked up by the scheduler tick's backstop.
 */

import { hostInfra, type LoadedPlugin, loadedPlugins } from "@caelo-cms/plugin-host";
import { BATCH_TRIGGERS, MAX_BATCH_RESULT_BYTES } from "@caelo-cms/plugin-sdk";
import { afterCommit, defineOperation, execute, uuidArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";
import { jsonbParam } from "../sql-helpers.js";
import { declaredBatch } from "./declared.js";

const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,54}$/);
const operationName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,119}$/);
/** An operator's input: small, JSON, read by the plugin as `args.input`. */
const batchInput = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16_384, "the input may take at most 16 KB");

/** A run as every reader sees it. */
export const batchRunSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  pluginSlug: z.string().nullable(),
  operation: z.string(),
  pluginVersion: z.string(),
  trigger: z.enum(BATCH_TRIGGERS),
  input: z.record(z.string(), z.unknown()),
  stageRunId: z.string().nullable(),
  state: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /**
   * #1776 — a queued run whose job waits for CPU: the capacity ledger's
   * reason ("waits for 4 vCPU: …"). Absent once it runs.
   */
  waitingForCpu: z.string().optional(),
});
export type BatchRun = z.infer<typeof batchRunSchema>;

interface RunRow {
  id: string;
  plugin_id: string;
  operation: string;
  plugin_version: string;
  trigger: BatchRun["trigger"];
  input: Record<string, unknown>;
  stage_run_id: string | null;
  state: BatchRun["state"];
  result: unknown;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const RUN_COLUMNS = sql`id::text AS id, plugin_id::text AS plugin_id, operation, plugin_version,
  trigger, input, stage_run_id::text AS stage_run_id, state, result, error,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
  to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at`;

function toRun(r: RunRow): BatchRun {
  return {
    id: r.id,
    pluginId: r.plugin_id,
    pluginSlug: loadedPlugins.byId(r.plugin_id)?.slug ?? null,
    operation: r.operation,
    pluginVersion: r.plugin_version,
    trigger: r.trigger,
    input: r.input ?? {},
    stageRunId: r.stage_run_id,
    state: r.state,
    result: r.result ?? null,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function refuse(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message, refusal: true as const });
}

/** Starts the run's job once its row committed; the tick's backstop starts one this missed. */
function startAfterCommit(tx: Parameters<typeof afterCommit>[0], runId: string): void {
  afterCommit(tx, {
    label: `start plugin batch run ${runId}`,
    entityId: runId,
    run: async () => {
      const infra = hostInfra();
      await startReportingJob(
        { adapter: infra.adapter, registry: infra.registry },
        "plugin_batch",
        runId,
      );
    },
  });
}

export const pluginBatchesStartOp = defineOperation({
  name: "plugin_batches.start",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginSlug: slug,
      operation: operationName,
      input: batchInput.optional(),
    })
    .strict(),
  output: z.object({ run: batchRunSchema }),
  handler: async (ctx, input, tx) => {
    const op = "plugin_batches.start";
    const plugin = loadedPlugins.bySlug(input.pluginSlug);
    const declared = declaredBatch(plugin, input.operation);
    if (!declared.ok) return refuse(op, `${declared.message}. list_plugins shows what is active.`);
    if (!declared.batch.triggers.includes("operator")) {
      return refuse(
        op,
        `the batch "${input.operation}" of plugin "${input.pluginSlug}" starts on its own (${declared.batch.triggers.join(", ")}), not on request`,
      );
    }
    const p = plugin as LoadedPlugin;
    const active = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM plugin_batch_runs
      WHERE plugin_id = ${p.pluginId}::uuid AND operation = ${input.operation} AND state IN ('queued', 'running')
    `)) as unknown as RunRow[];
    if (active[0]) {
      return refuse(
        op,
        `the batch "${input.operation}" is already ${active[0].state} (run ${active[0].id}, since ${active[0].started_at ?? active[0].created_at}); wait for it (list_plugin_batches) or stop it (stop_plugin_batch) first`,
      );
    }
    const rows = (await tx.execute(sql`
      INSERT INTO plugin_batch_runs (plugin_id, operation, plugin_version, trigger, input, requested_by)
      VALUES (${p.pluginId}::uuid, ${input.operation}, ${p.version}, 'operator',
              ${jsonbParam(input.input ?? {})}, ${ctx.actorKind === "system" ? null : ctx.actorId}::uuid)
      RETURNING ${RUN_COLUMNS}
    `)) as unknown as RunRow[];
    const run = rows[0] as RunRow;
    startAfterCommit(tx, run.id);
    return ok({ run: toRun(run) });
  },
});

export const pluginBatchesEnqueueOp = defineOperation({
  name: "plugin_batches.enqueue",
  readScope: "request",
  // Why system-only: the triggers (activation, Stage, schedule) queue runs;
  // people and the AI start one with plugin_batches.start.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      pluginId: uuid,
      operation: operationName,
      trigger: z.enum(["activation", "stage", "schedule"]),
      stageRunId: uuid.optional(),
    })
    .strict(),
  output: z.object({ runId: z.string().nullable() }),
  handler: async (_ctx, input, tx) => {
    const plugin = loadedPlugins.byId(input.pluginId);
    const declared = declaredBatch(plugin, input.operation);
    if (!declared.ok || !declared.batch.triggers.includes(input.trigger))
      return ok({ runId: null });
    const p = plugin as LoadedPlugin;
    // An activation batch runs once per version: every instance's boot load
    // tells the listener too, and none of those may run it again.
    if (input.trigger === "activation") {
      const ran = (await tx.execute(sql`
        SELECT 1 FROM plugin_batch_runs
        WHERE plugin_id = ${p.pluginId}::uuid AND operation = ${input.operation}
          AND trigger = 'activation' AND plugin_version = ${p.version}
        LIMIT 1
      `)) as unknown as unknown[];
      if (ran.length > 0) return ok({ runId: null });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO plugin_batch_runs (plugin_id, operation, plugin_version, trigger, stage_run_id)
      VALUES (${p.pluginId}::uuid, ${input.operation}, ${p.version}, ${input.trigger},
              ${input.stageRunId ?? null}::uuid)
      ON CONFLICT (plugin_id, operation) WHERE state IN ('queued', 'running') DO NOTHING
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const runId = rows[0]?.id ?? null;
    if (runId) startAfterCommit(tx, runId);
    return ok({ runId });
  },
});

export const pluginBatchesListOp = defineOperation({
  name: "plugin_batches.list",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginSlug: slug.optional(),
      state: z.enum(["queued", "running", "completed", "failed", "stopped"]).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({ runs: z.array(batchRunSchema) }),
  handler: async (_ctx, input, tx) => {
    const pluginId = input.pluginSlug
      ? loadedPlugins.bySlug(input.pluginSlug)?.pluginId
      : undefined;
    if (input.pluginSlug && !pluginId) return ok({ runs: [] });
    const rows = (await tx.execute(sql`
      SELECT ${RUN_COLUMNS} FROM plugin_batch_runs
      WHERE (${pluginId ?? null}::uuid IS NULL OR plugin_id = ${pluginId ?? null}::uuid)
        AND (${input.state ?? null}::text IS NULL OR state = ${input.state ?? null})
      ORDER BY created_at DESC
      LIMIT ${input.limit}
    `)) as unknown as RunRow[];
    // #1776 — why a queued run has not started: its job waits for CPU.
    const queued = rows.filter((r) => r.state === "queued").map((r) => r.id);
    const waits =
      queued.length === 0
        ? []
        : ((await tx.execute(sql`
            SELECT subject_id::text AS id, waiting_reason FROM job_capacity_bookings
             WHERE kind = 'plugin_batch' AND subject_id = ANY(${uuidArray(queued)})
               AND role = 'lead' AND state = 'waiting'
          `)) as unknown as { id: string; waiting_reason: string | null }[]);
    return ok({
      runs: rows.map((r) => {
        const reason = waits.find((w) => w.id === r.id)?.waiting_reason;
        return reason ? { ...toRun(r), waitingForCpu: reason } : toRun(r);
      }),
    });
  },
});

export const pluginBatchesStopOp = defineOperation({
  name: "plugin_batches.stop",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ stopped: z.boolean(), run: batchRunSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE plugin_batch_runs SET state = 'stopped', finished_at = now(),
        error = 'stopped on request'
      WHERE id = ${input.runId}::uuid AND state IN ('queued', 'running')
      RETURNING ${RUN_COLUMNS}
    `)) as unknown as RunRow[];
    if (rows[0]) {
      // #1776 — a run that still waited for CPU leaves the queue, so it
      // holds back nothing behind it.
      afterCommit(tx, {
        label: `cancel the CPU booking of stopped batch run ${input.runId}`,
        entityId: input.runId,
        run: async () => {
          const infra = hostInfra();
          const r = await execute(
            infra.registry,
            infra.adapter,
            REPORTING_JOB_CTX,
            "job_capacity.cancel",
            {
              kind: "plugin_batch",
              subjectId: input.runId,
            },
          );
          if (!r.ok) throw new Error(`job_capacity.cancel failed: ${describeError(r.error)}`);
        },
      });
      return ok({ stopped: true, run: toRun(rows[0]) });
    }
    const now = (await tx.execute(
      sql`SELECT ${RUN_COLUMNS} FROM plugin_batch_runs WHERE id = ${input.runId}::uuid`,
    )) as unknown as RunRow[];
    return ok({ stopped: false, run: now[0] ? toRun(now[0]) : null });
  },
});

export const pluginBatchesGetOp = defineOperation({
  name: "plugin_batches.get",
  readScope: "request",
  // Why system-only: the job's reports read their run; people use list.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ run: batchRunSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT ${RUN_COLUMNS} FROM plugin_batch_runs WHERE id = ${input.runId}::uuid`,
    )) as unknown as RunRow[];
    return ok({ run: rows[0] ? toRun(rows[0]) : null });
  },
});

export const pluginBatchesClaimOp = defineOperation({
  name: "plugin_batches.claim",
  readScope: "request",
  // Why system-only: the job's order report.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ runId: uuid }).strict(),
  output: z.object({ run: batchRunSchema.nullable() }),
  handler: async (_ctx, input, tx) => {
    // A retry of a dead attempt claims the running run again.
    const rows = (await tx.execute(sql`
      UPDATE plugin_batch_runs SET state = 'running', started_at = COALESCE(started_at, now())
      WHERE id = ${input.runId}::uuid AND state IN ('queued', 'running')
      RETURNING ${RUN_COLUMNS}
    `)) as unknown as RunRow[];
    return ok({ run: rows[0] ? toRun(rows[0]) : null });
  },
});

export const pluginBatchesFinishOp = defineOperation({
  name: "plugin_batches.finish",
  readScope: "request",
  // Why system-only: the job's end, or the backstop giving the run up.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      runId: uuid,
      state: z.enum(["completed", "failed", "stopped"]),
      result: z.unknown().optional(),
      error: z.string().max(4000).optional(),
    })
    .strict(),
  output: z.object({ finished: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    let result = input.result ?? null;
    if (result !== null && JSON.stringify(result).length > MAX_BATCH_RESULT_BYTES)
      result = {
        truncated: true,
        note: `the result was larger than ${MAX_BATCH_RESULT_BYTES} bytes`,
      };
    // A run stopped meanwhile stays stopped: its end is the operator's.
    const rows = (await tx.execute(sql`
      UPDATE plugin_batch_runs SET state = ${input.state}, finished_at = now(),
        result = ${result === null ? null : jsonbParam(result)}, error = ${input.error ?? null}
      WHERE id = ${input.runId}::uuid AND state IN ('queued', 'running')
      RETURNING id
    `)) as unknown as unknown[];
    return ok({ finished: rows.length > 0 });
  },
});

export const pluginBatchesUnstartedOp = defineOperation({
  name: "plugin_batches.unstarted",
  readScope: "request",
  // Why system-only: the scheduler tick's backstop.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.object({ runIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id FROM plugin_batch_runs r
      WHERE r.state = 'queued' AND r.created_at < now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM reporting_jobs j WHERE j.kind = 'plugin_batch' AND j.subject_id = r.id)
      ORDER BY r.created_at
      LIMIT ${input.limit}
    `)) as unknown as { id: string }[];
    return ok({ runIds: rows.map((r) => r.id) });
  },
});

export const pluginBatchesArtifactOp = defineOperation({
  name: "plugin_batches.artifact",
  readScope: "request",
  // Why system-only: the job's order of an installed plugin's run; the
  // caller checks it against the plugin's approved artifact digest.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ pluginId: uuid }).strict(),
  output: z.object({ manifest: z.unknown(), source: z.string() }).nullable(),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT manifest_json, source_code FROM plugins
      WHERE id = ${input.pluginId}::uuid AND tier = 2 AND status = 'active'
    `)) as unknown as { manifest_json: unknown; source_code: string | null }[];
    const row = rows[0];
    if (!row?.source_code) return ok(null);
    return ok({ manifest: row.manifest_json, source: row.source_code });
  },
});

/** Every plugin-batch op, for register.ts. */
export const PLUGIN_BATCH_OPS = [
  pluginBatchesStartOp,
  pluginBatchesEnqueueOp,
  pluginBatchesListOp,
  pluginBatchesStopOp,
  pluginBatchesGetOp,
  pluginBatchesClaimOp,
  pluginBatchesFinishOp,
  pluginBatchesUnstartedOp,
  pluginBatchesArtifactOp,
] as const;
