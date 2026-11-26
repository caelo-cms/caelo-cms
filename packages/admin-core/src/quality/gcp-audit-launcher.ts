// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — parallel audit tasks on GCP installs (`gcp`, `gcp-firebase`):
 * ONE Cloud Run job execution per batch, with `taskCount` = as many runs as
 * the project's CPU quota lets run at once (`RunCapacity.lighthouseTasks`,
 * reporting-jobs/run-capacity.ts) or fewer; every task runs the batch's
 * orders of its `CLOUD_RUN_TASK_INDEX`, one after another (audit-task.ts).
 * The job definition sets no `parallelism`: with one, Cloud Run refuses to
 * create the job on a project whose quota is smaller than its width.
 *
 * Trust boundary. The audit job runs as its own service account, which may
 * read the staged build (the staging and static buckets, read-only), create
 * objects in the audit results bucket and write logs — nothing else: no
 * Cloud SQL (and no VPC egress to reach it), no Secret Manager. Plugin
 * calls on the audited pages go to the site's public gateway, as a
 * visitor's would (staged-origin.ts). The admin
 * may run that one job WITH overrides (it must pass the batch), read its
 * executions and read the results bucket. A compromised admin can therefore
 * make the job load other URLs, but the job holds nothing worth taking.
 * Contrast the operator-access job (security/operator-access/
 * gcp-job-trigger.ts), whose identity CAN change IAM and which the admin
 * may only start without overrides.
 */

import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";
import { type AuditResultStore, gcsAuditResultStore } from "./audit-results-store.js";
import { AUDIT_TASK_ENV_VAR } from "./audit-task-protocol.js";
import {
  type AuditBatchProgress,
  type AuditTaskLauncher,
  parallelAuditTimeoutMs,
} from "./parallel-runner.js";

/** The admin env var naming the audit job (`projects/<p>/locations/<r>/jobs/<j>`). */
export const AUDIT_JOB_ENV_VAR = "CAELO_AUDIT_JOB";

const JOB_NAME = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/;

interface Execution {
  readonly taskCount?: number;
  readonly succeededCount?: number;
  readonly failedCount?: number;
  readonly cancelledCount?: number;
  readonly completionTime?: string;
}

/** A Cloud Run execution's counts as batch progress. Pure; exported for tests. */
export function executionProgress(e: Execution): AuditBatchProgress {
  const failed = (e.failedCount ?? 0) + (e.cancelledCount ?? 0);
  const done = (e.succeededCount ?? 0) + failed;
  return {
    failed,
    finished: e.completionTime !== undefined || (e.taskCount !== undefined && done >= e.taskCount),
  };
}

/**
 * The launcher for a Cloud Run audit job.
 *
 * @param job - the job's full resource name.
 * @param results - the audit results store the tasks write into.
 * @param tasksAtOnce - Lighthouse runs at once (`RunCapacity.lighthouseTasks`).
 */
export function gcpAuditLauncher(
  job: string,
  results: AuditResultStore,
  tasksAtOnce: number,
  deps: GoogleDeps = defaultGoogleDeps(),
): AuditTaskLauncher {
  if (!JOB_NAME.test(job))
    throw new Error(`${AUDIT_JOB_ENV_VAR} is not a Cloud Run job name: ${job}`);
  if (!Number.isInteger(tasksAtOnce) || tasksAtOnce < 1)
    throw new Error(`Lighthouse runs at once must be a positive whole number, got ${tasksAtOnce}`);
  return {
    label: `Cloud Run job ${job.split("/").pop()}`,
    tasksAtOnce,
    async start(batch) {
      const taskCount = Math.min(batch.orders.length, tasksAtOnce);
      const rounds = Math.ceil(batch.orders.length / taskCount);
      const op = (await googleCall(deps, `https://run.googleapis.com/v2/${job}:run`, "POST", {
        overrides: {
          taskCount,
          // Per task: it runs `rounds` orders one after another.
          timeout: `${Math.round(parallelAuditTimeoutMs(rounds) / 1000)}s`,
          containerOverrides: [
            { env: [{ name: AUDIT_TASK_ENV_VAR, value: JSON.stringify(batch) }] },
          ],
        },
      })) as { metadata?: { name?: string } };
      const name = op.metadata?.name;
      if (!name) throw new Error("Cloud Run started the audit but returned no execution name");
      return name;
    },
    async progress(execution) {
      return executionProgress(
        (await googleCall(deps, `https://run.googleapis.com/v2/${execution}`, "GET")) as Execution,
      );
    },
    readResult: (key) => results.read(key),
  };
}

/**
 * The GCP launcher from the audit runner's env, or null on other providers.
 *
 * @param tasksAtOnce - from the runner's order (`JobOrder.capacity`); a
 *   GCP order without it is refused rather than guessed.
 */
export function gcpAuditLauncherFromEnv(
  env: NodeJS.ProcessEnv,
  tasksAtOnce: number | undefined,
): AuditTaskLauncher | null {
  if (env.CAELO_PROVIDER !== "gcp" && env.CAELO_PROVIDER !== "gcp-firebase") return null;
  const job = env[AUDIT_JOB_ENV_VAR]?.trim();
  const bucket = env.CAELO_AUDIT_RESULTS_BUCKET?.trim();
  if (!job || !bucket) {
    throw new Error(
      `${AUDIT_JOB_ENV_VAR} / CAELO_AUDIT_RESULTS_BUCKET are not set on the admin, so it cannot run the parallel audit — run \`cms-provision upgrade\``,
    );
  }
  if (tasksAtOnce === undefined) {
    throw new Error(
      "the audit runner's order carries no CPU capacity, so it cannot tell how many Lighthouse runs the project's quota allows at once — the admin that started it is older than its job; run `cms-provision upgrade`",
    );
  }
  return gcpAuditLauncher(job, gcsAuditResultStore(bucket), tasksAtOnce);
}
