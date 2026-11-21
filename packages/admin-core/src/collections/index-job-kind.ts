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
import {
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";

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

const reportTarget = {
  pluginId: z.string().uuid(),
  collection: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
};

export const collectionIndexJobKind: ReportingJobKindDef = {
  kind: "collection_index",
  label: "search index",
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
      async handle(deps, runId, input) {
        await op(deps, "collections.index_done", { runId, ...input });
        if ((await pendingLeft(deps, runId)) > 0) return { value: {} };
        return {
          value: {},
          done: { outcome: "completed", note: "every collection of the run is indexed" },
        };
      },
    },
    failed: {
      input: z.object({ ...reportTarget, error: z.string().min(1).max(4000) }).strict(),
      async handle(deps, runId, input) {
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
