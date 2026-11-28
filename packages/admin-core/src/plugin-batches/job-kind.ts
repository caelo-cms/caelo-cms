// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — the `plugin_batch` reporting job, admin
 * side: what the admin does with each report of a run of a plugin's batch
 * operation.
 *
 *   order   the run moves to running; the job gets what it runs (the
 *           operation, its arguments, which handles the plugin has, and an
 *           installed plugin's verified artifact)
 *   call    one SDK call the operation made, answered on the context the
 *           admin builds for the plugin (origin `batch`): the plugin's own
 *           grants, nothing the job says can widen them
 *   done    the result; the run is completed
 *   failed  the error; the run failed
 *
 * A batch in pieces (#1776) also reports `pieces` (the lead, its plan's
 * keys), `claim` and `piece-done` (every task), and `leave` (a helper's
 * task with nothing left): the capacity ledger runs its pieces on as many
 * tasks as CPU is free.
 *
 * Every report re-reads the run: a run stopped by the operator, a plugin
 * deactivated or updated meanwhile, ends the attempt at its next report.
 */

import {
  brokerSandboxCall,
  externalArtifactDigest,
  hostSystemActorId,
  loadedPlugins,
  makeInvocationContext,
  sandboxMethod,
} from "@caelo-cms/plugin-host";
import {
  BATCH_SIZES,
  MAX_BATCH_PIECES,
  type PluginContextTier1,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { MAX_CLAIM_SECONDS, MAX_PIECES, type PieceClaim, workerName } from "../ops/job_pieces.js";
import {
  ActionRefusal,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";
import { declaredBatch } from "./declared.js";
import type { BatchRun } from "./ops.js";

/** The admin env var naming the Cloud Run job a batch runs in. */
export const PLUGIN_BATCH_JOB_ENV_VAR = "CAELO_PLUGIN_BATCH_JOB";

/** #1776 — the admin env vars naming the batch jobs of the larger machines. */
export const PLUGIN_BATCH_SIZED_JOB_ENV_VARS = {
  M: "CAELO_PLUGIN_BATCH_JOB_M",
  L: "CAELO_PLUGIN_BATCH_JOB_L",
} as const;

/** The admin env var naming the only service account a batch job's reports pass IAP as. */
export const PLUGIN_BATCH_SERVICE_ACCOUNT_ENV_VAR = "CAELO_PLUGIN_BATCH_SERVICE_ACCOUNT";

/** Which handles the plugin's batch context carries (the job builds the same shape). */
export interface BatchHandles {
  readonly hasAdminQuery: boolean;
  readonly hasPrivateFiles: boolean;
  readonly hasConfig: boolean;
  readonly collections: readonly string[];
}

/** What the job runs: the `order` answer. */
export interface BatchOrder {
  readonly runId: string;
  readonly slug: string;
  readonly version: string;
  readonly tier: 1 | 2;
  readonly operation: string;
  readonly maxRunSeconds: number;
  readonly args: {
    readonly trigger: BatchRun["trigger"];
    readonly batchRunId: string;
    readonly stageRunId: string | null;
    readonly input: Readonly<Record<string, unknown>>;
    /** The piece a call works on; null in the order (the job sets it per piece). */
    readonly piece: string | null;
  };
  /** #1776 — a batch in pieces: its plan operation; null for a batch on one task. */
  readonly pieces: { readonly plan: string } | null;
  readonly invocation: PluginInvocation;
  readonly handles: BatchHandles;
  /** An installed plugin's artifact, verified against its approval. */
  readonly artifact: { readonly manifest: unknown; readonly source: string } | null;
}

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

function invocationOf(runId: string): PluginInvocation {
  return { origin: "batch", actorId: hostSystemActorId(), batchRunId: runId };
}

/**
 * The run, if it may go on, with its loaded plugin; otherwise ends it and
 * refuses the report (the job stops).
 */
async function liveRun(deps: AdminJobDeps, runId: string, opts: { claim: boolean }) {
  const { run } = await op<{ run: BatchRun | null }>(
    deps,
    opts.claim ? "plugin_batches.claim" : "plugin_batches.get",
    { runId },
  );
  if (!run || (run.state !== "running" && run.state !== "queued")) {
    throw new ActionRefusal(
      run ? `the batch run ${runId} is ${run.state}` : `there is no batch run ${runId}`,
    );
  }
  const plugin = loadedPlugins.byId(run.pluginId);
  const declared = declaredBatch(plugin, run.operation);
  const problem = !declared.ok
    ? declared.message
    : plugin?.version !== run.pluginVersion
      ? `plugin "${plugin?.slug}" was updated to ${plugin?.version} after the run started for ${run.pluginVersion}; start the batch again`
      : null;
  if (problem || !plugin || !declared.ok) {
    await op(deps, "plugin_batches.finish", { runId, state: "stopped", error: problem });
    throw new ActionRefusal(`the batch run ${runId} stopped: ${problem}`);
  }
  return { run, plugin, batch: declared.batch };
}

export const pluginBatchJobKind: ReportingJobKindDef = {
  kind: "plugin_batch",
  label: "plugin batch",
  capability: "batch_jobs",
  gcp: {
    jobEnvVar: PLUGIN_BATCH_JOB_ENV_VAR,
    serviceAccountEnvVar: PLUGIN_BATCH_SERVICE_ACCOUNT_ENV_VAR,
    sizedJobEnvVars: PLUGIN_BATCH_SIZED_JOB_ENV_VARS,
  },
  pendingIssue: {
    aws: "issue #749: an ECS task per plugin batch run",
    azure: "issue #750: a Container Apps job per plugin batch run",
  },
  // In-process (self-hosted): one batch at a time, so a long batch cannot
  // take more than one share of the admin's CPU.
  inProcess: "in-line",
  unstarted: "start",
  // #1776 — background work on the machine its batch declares; a batch in
  // pieces is elastic. A run whose batch is gone books the smallest machine
  // and stops at its `order`, before it runs anything.
  async capacity(deps, runId) {
    const { run } = await op<{ run: BatchRun | null }>(deps, "plugin_batches.get", { runId });
    const declared = run ? declaredBatch(loadedPlugins.byId(run.pluginId), run.operation) : null;
    const batch = declared?.ok ? declared.batch : null;
    const size = batch?.size ?? "S";
    return {
      cls: "background",
      vcpuPerTask: BATCH_SIZES[size].vcpu,
      elastic: batch?.pieces !== undefined && batch?.pieces !== null,
      maxTasks: batch?.pieces?.maxTasks ?? 1,
      auditReserve: false,
      size,
    };
  },
  actions: {
    order: {
      input: z.object({}).strict(),
      async handle(deps, runId, _input, request) {
        // A helper reads the run its lead claimed.
        const { run, plugin, batch } = await liveRun(deps, runId, {
          claim: request.helperId === null,
        });
        const invocation = invocationOf(runId);
        const ctx = (await makeInvocationContext(plugin.slug, invocation)) as PluginContextTier1;
        let artifact: BatchOrder["artifact"] = null;
        if (plugin.tier === 2) {
          const a = await op<{ manifest: unknown; source: string } | null>(
            deps,
            "plugin_batches.artifact",
            { pluginId: plugin.pluginId },
          );
          const digest = plugin.externalApproval?.artifactDigest;
          if (!a || !digest || externalArtifactDigest(a.manifest, a.source) !== digest) {
            await op(deps, "plugin_batches.finish", {
              runId,
              state: "failed",
              error: "the installed plugin's stored artifact does not match its approval",
            });
            throw new ActionRefusal(`the batch run ${runId}: artifact mismatch`);
          }
          artifact = a;
        }
        const order: BatchOrder = {
          runId,
          slug: plugin.slug,
          version: plugin.version,
          tier: plugin.tier === 2 ? 2 : 1,
          operation: run.operation,
          maxRunSeconds: batch.maxRunSeconds,
          args: {
            trigger: run.trigger,
            batchRunId: runId,
            stageRunId: run.stageRunId,
            input: run.input,
            piece: null,
          },
          pieces: batch.pieces ? { plan: batch.pieces.plan } : null,
          invocation,
          handles: {
            hasAdminQuery: Boolean(ctx.adminQuery),
            hasPrivateFiles: Boolean(ctx.privateFiles),
            hasConfig: Boolean(ctx.config),
            collections: Object.keys(ctx.collections ?? {}),
          },
          artifact,
        };
        return { value: order };
      },
    },
    call: {
      input: z
        .object({
          method: sandboxMethod,
          args: z.array(z.unknown()).max(4),
        })
        .strict(),
      async handle(deps, runId, input) {
        const { plugin } = await liveRun(deps, runId, { claim: false });
        const ctx = await makeInvocationContext(plugin.slug, invocationOf(runId));
        try {
          const value = await brokerSandboxCall(ctx, input.method, input.args);
          return {
            value: {
              ok: true,
              value: value instanceof Map ? [...value.entries()] : (value ?? null),
            },
          };
        } catch (e) {
          // The plugin's call failed, not the report: the operation sees a
          // rejected promise and may go on, as everywhere else.
          return { value: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      },
    },
    // #1776 — the lead names its plan's pieces; helpers may join for them.
    pieces: {
      input: z
        .object({ keys: z.array(z.string().min(1).max(200)).min(1).max(MAX_BATCH_PIECES) })
        .strict(),
      async handle(deps, runId, input, request) {
        if (request.helperId !== null)
          throw new ActionRefusal("only the lead names a batch's pieces");
        const { run, batch } = await liveRun(deps, runId, { claim: false });
        const value = await op(deps, "job_pieces.register", {
          kind: "plugin_batch",
          subjectId: runId,
          scope: run.operation,
          count: input.keys.length,
          done: [],
          keys: input.keys,
          wantedTasks: Math.min(batch.pieces?.maxTasks ?? 1, input.keys.length),
        });
        return { value, readmit: true };
      },
    },
    claim: {
      input: z
        .object({
          worker: workerName,
          claimSeconds: z.number().int().min(60).max(MAX_CLAIM_SECONDS),
        })
        .strict(),
      async handle(deps, runId, input, request) {
        const { run } = await liveRun(deps, runId, { claim: false });
        const value = await op<PieceClaim>(deps, "job_pieces.claim", {
          kind: "plugin_batch",
          subjectId: runId,
          scope: run.operation,
          worker: input.worker,
          helperId: request.helperId,
          attempt: request.attempt,
          claimSeconds: input.claimSeconds,
          leaseSeconds: 10 * 60,
        });
        return "stop" in value ? { value, readmit: true } : { value };
      },
    },
    "piece-done": {
      input: z
        .object({
          piece: z
            .number()
            .int()
            .min(0)
            .max(MAX_PIECES - 1),
        })
        .strict(),
      async handle(deps, runId, input) {
        const { run } = await liveRun(deps, runId, { claim: false });
        const value = await op(deps, "job_pieces.done", {
          kind: "plugin_batch",
          subjectId: runId,
          scope: run.operation,
          piece: input.piece,
        });
        return { value };
      },
    },
    leave: {
      input: z.object({ worker: workerName }).strict(),
      async handle(deps, _runId, input, request) {
        if (request.helperId === null)
          throw new ActionRefusal("only a helper's task leaves its run");
        await op(deps, "job_capacity.leave", { bookingId: request.helperId, worker: input.worker });
        return { value: {}, readmit: true };
      },
    },
    done: {
      input: z.object({ value: z.unknown() }).strict(),
      async handle(deps, runId, input, request) {
        if (request.helperId !== null) throw new ActionRefusal("only the lead ends a batch run");
        await op(deps, "plugin_batches.finish", {
          runId,
          state: "completed",
          result: input.value ?? null,
        });
        return { value: {}, done: { outcome: "completed" } };
      },
    },
    failed: {
      input: z.object({ error: z.string().min(1).max(4000) }).strict(),
      async handle(deps, runId, input) {
        await op(deps, "plugin_batches.finish", { runId, state: "failed", error: input.error });
        // Operators read the job's outcome in the logs too, not only on the
        // plugin's page: the plugin's own error text, never its data.
        console.warn(`[plugin-batch] run ${runId} failed: ${input.error.slice(0, 500)}`);
        return { value: {}, done: { outcome: "completed", note: "the batch failed" } };
      },
    },
  },
  async listUnstarted(deps, limit) {
    return (await op<{ runIds: string[] }>(deps, "plugin_batches.unstarted", { limit })).runIds;
  },
  async giveUp(deps, runId, message) {
    await op(deps, "plugin_batches.finish", {
      runId,
      state: "failed",
      error: `the batch job gave up: ${message}`.slice(0, 4000),
    });
  },
};
