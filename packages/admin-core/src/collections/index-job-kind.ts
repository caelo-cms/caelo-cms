// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2, issue #1648) — the `collection_index` reporting job: one
 * attempt per Stage run whose collections need a new release. The admin
 * answers what to index and records each release; everything heavy (folding
 * changes, analysis, segments, vectors) runs in the job (index-job.ts).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { indexTasksAlone, quotaForIndexTasks } from "../job-capacity/budget.js";
import { INDEX_TASK_VCPU } from "../job-capacity/plan.js";
import type { CapacityBooking } from "../ops/job_capacity.js";
import { MAX_CLAIM_SECONDS, type PieceClaim, workerName } from "../ops/job_pieces.js";
import {
  ActionRefusal,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";
import { MAX_JOB_TASKS } from "../reporting-jobs/protocol.js";
import { shardScope } from "./index-job.js";
import type { IndexLimit } from "./progress.js";

/** The admin env var naming the index job's Cloud Run job (Google Cloud). */
export const COLLECTION_INDEX_JOB_ENV_VAR = "CAELO_COLLECTION_INDEX_JOB";

/** The admin env var naming the service account the index job's reports pass IAP as. */
export const COLLECTION_INDEX_SERVICE_ACCOUNT_ENV_VAR = "CAELO_COLLECTION_INDEX_SERVICE_ACCOUNT";

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

async function pendingLeft(deps: AdminJobDeps, runId: string): Promise<number> {
  const s = await op<{ collections: { state: string }[] }>(deps, "collections.run_state", {
    runId,
  });
  return s.collections.filter((c) => c.state === "pending").length;
}

/** How far ahead a helper's booking is kept by its claims (its heartbeats keep it too). */
const JOB_LEASE_SECONDS = 10 * 60;

const reportTarget = {
  pluginId: z.string().uuid(),
  collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
};

/** Only the lead reports a collection's release or failure; a helper only embeds. */
function leadOnly(helperId: string | null, action: string): void {
  if (helperId !== null)
    throw new ActionRefusal(`a helper of the search index does not report "${action}"`);
}

/** The pieces' key of a work: the run's index job. */
const work = (runId: string) => ({ kind: "collection_index", subjectId: runId });

/**
 * How many tasks the run's index holds now, and the quota limit when the
 * budget keeps it narrower than it would run with nothing else beside it.
 */
async function widthOf(
  deps: AdminJobDeps,
  runId: string,
  wantedTasks: number,
): Promise<{ tasks: number; limit: IndexLimit | null }> {
  const list = await op<{
    budget: {
      source: "quota" | "machine";
      budgetVcpu: number | null;
      quotaVcpu: number | null;
      projectId: string | null;
      region: string | null;
    } | null;
    bookings: CapacityBooking[];
  }>(deps, "job_capacity.list", {});
  const own = list.bookings.find((b) => b.kind === "collection_index" && b.subjectId === runId);
  const tasks = Math.max(1, own?.tasks ?? 1);
  const b = list.budget;
  const limited =
    b !== null &&
    b.source === "quota" &&
    b.quotaVcpu !== null &&
    b.projectId !== null &&
    b.region !== null &&
    indexTasksAlone(b.budgetVcpu) < wantedTasks;
  return {
    tasks,
    limit: limited
      ? {
          wantedTasks,
          quotaVcpu: b.quotaVcpu as number,
          quotaNeededVcpu: quotaForIndexTasks(wantedTasks),
          projectId: b.projectId as string,
          region: b.region as string,
        }
      : null,
  };
}

export const collectionIndexJobKind: ReportingJobKindDef = {
  kind: "collection_index",
  label: "search index",
  capability: "collections",
  gcp: {
    jobEnvVar: COLLECTION_INDEX_JOB_ENV_VAR,
    serviceAccountEnvVar: COLLECTION_INDEX_SERVICE_ACCOUNT_ENV_VAR,
  },
  pendingIssue: {
    aws: "issue #749: an ECS task per Stage's search index",
    azure: "issue #750: a Container Apps job per Stage's search index",
  },
  // One index at a time in-process: two would compete for the same store files.
  inProcess: "in-line",
  unstarted: "start",
  // Publish live waits for it; its tasks claim shards, and helpers join
  // while CPU is free (#1776).
  capacity: async () => ({
    cls: "stage",
    vcpuPerTask: INDEX_TASK_VCPU,
    elastic: true,
    maxTasks: MAX_JOB_TASKS,
    auditReserve: false,
  }),
  actions: {
    tasks: {
      input: z.object({}).strict(),
      async handle(deps, runId) {
        const value = await op<{ tasks: unknown[] }>(deps, "collections.index_tasks", { runId });
        if (value.tasks.length === 0)
          return { value, done: { outcome: "completed", note: "nothing to index" } };
        return { value };
      },
    },
    done: {
      input: z
        .object({
          ...reportTarget,
          releaseKey: z.string().regex(/^[a-z0-9-]+\.json$/),
          stats: z.record(z.string(), z.unknown()),
        })
        .strict(),
      async handle(deps, runId, input, request) {
        leadOnly(request.helperId, "done");
        await op(deps, "collections.index_done", { runId, ...input });
        if ((await pendingLeft(deps, runId)) > 0) return { value: {} };
        return {
          value: {},
          done: { outcome: "completed", note: "every collection of the run is indexed" },
        };
      },
    },
    // A task's embedding progress, for the Stage status and the Publish live gate (progress.ts).
    progress: {
      input: z
        .object({
          ...reportTarget,
          worker: workerName,
          embedded: z.number().int().min(0),
          planned: z.number().int().min(0),
          wantedTasks: z.number().int().min(1).max(MAX_JOB_TASKS),
        })
        .strict(),
      async handle(deps, runId, input) {
        // The width and the quota's limit are the ledger's, not the job's word.
        const { tasks, limit } = await widthOf(deps, runId, input.wantedTasks);
        await op(deps, "collections.index_progress", {
          runId,
          pluginId: input.pluginId,
          collection: input.collection,
          worker: input.worker,
          tasks,
          embedded: input.embedded,
          toEmbed: input.embedded,
          planned: input.planned,
          ...(limit ? { limit } : {}),
        });
        return { value: {} };
      },
    },
    // #1776 — the lead names a build's shards; helpers may join for them.
    pieces: {
      input: z
        .object({
          ...reportTarget,
          count: z.number().int().min(1).max(100_000),
          done: z.array(z.number().int().min(0).max(99_999)).max(100_000),
          wantedTasks: z.number().int().min(1).max(MAX_JOB_TASKS),
        })
        .strict(),
      async handle(deps, runId, input, request) {
        leadOnly(request.helperId, "pieces");
        await op(deps, "collections.index_reset_progress", { runId });
        const value = await op(deps, "job_pieces.register", {
          ...work(runId),
          scope: shardScope(input),
          count: input.count,
          done: input.done,
          wantedTasks: input.wantedTasks,
          attempt: request.attempt,
        });
        return { value, readmit: true };
      },
    },
    // A task takes the next shard; a helper may hear `stop` instead.
    claim: {
      input: z
        .object({
          ...reportTarget,
          worker: workerName,
          claimSeconds: z.number().int().min(60).max(MAX_CLAIM_SECONDS),
        })
        .strict(),
      async handle(deps, runId, input, request) {
        const value = await op<PieceClaim>(deps, "job_pieces.claim", {
          ...work(runId),
          scope: shardScope(input),
          worker: input.worker,
          helperId: request.helperId,
          claimSeconds: input.claimSeconds,
          leaseSeconds: JOB_LEASE_SECONDS,
        });
        // A helper that stopped freed its CPU for the job that waited for it.
        return "stop" in value ? { value, readmit: true } : { value };
      },
    },
    "piece-done": {
      input: z.object({ ...reportTarget, piece: z.number().int().min(0).max(99_999) }).strict(),
      async handle(deps, runId, input) {
        const value = await op(deps, "job_pieces.done", {
          ...work(runId),
          scope: shardScope(input),
          piece: input.piece,
        });
        return { value };
      },
    },
    // Where a new helper can help: the collections with shards left.
    "open-scopes": {
      input: z.object({}).strict(),
      async handle(deps, runId) {
        return { value: await op(deps, "job_pieces.open_scopes", work(runId)) };
      },
    },
    // A helper's task found no shard left for it: its CPU comes back.
    leave: {
      input: z.object({ worker: workerName }).strict(),
      async handle(deps, _runId, input, request) {
        if (request.helperId === null)
          throw new ActionRefusal("only a helper's task leaves its work");
        await op(deps, "job_capacity.leave", { bookingId: request.helperId, worker: input.worker });
        return { value: {}, readmit: true };
      },
    },
    failed: {
      input: z.object({ ...reportTarget, error: z.string().min(1).max(4000) }).strict(),
      async handle(deps, runId, input, request) {
        leadOnly(request.helperId, "failed");
        await op(deps, "collections.index_failed", { runId, ...input });
        if ((await pendingLeft(deps, runId)) > 0) return { value: {} };
        return {
          value: {},
          done: { outcome: "completed", note: "the run's index ended with a failure" },
        };
      },
    },
  },
  async listUnstarted(deps, limit) {
    const r = await op<{ runIds: string[] }>(deps, "collections.unstarted_runs", { limit });
    return r.runIds;
  },
  async giveUp(deps, runId, message) {
    await op(deps, "collections.index_failed", {
      runId,
      error: `the search index job gave up: ${message}`,
    });
  },
};
