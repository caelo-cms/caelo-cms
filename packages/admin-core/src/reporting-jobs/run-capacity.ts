// SPDX-License-Identifier: MPL-2.0

/**
 * How many job tasks an install's Google Cloud project lets run at once:
 * the quality check's Lighthouse runs and a large search index's tasks.
 *
 * Cloud Run has one CPU quota per project and region ("Total CPU
 * allocation", `run.googleapis.com/cpu_allocation`, in milli vCPU). Every
 * running instance counts against it, services and job tasks alike, and a
 * job whose `parallelism` times its CPU exceeds it cannot even be created.
 * Projects created before 2026 have thousands of vCPU there; a new
 * project gets 20. A fixed width (15 Lighthouse runs of 2 vCPU, 32 index
 * tasks of 2 vCPU) therefore stopped a fresh install outright, and would
 * have taken the admin's and the gateway's room on a small quota.
 *
 * So the width is read, not configured: the admin reads the quota when it
 * starts a job (`readRunCapacity`) and plans from it (`planRunCapacity`):
 *
 *   1. {@link RESERVED_VCPU} stay for what must keep answering: the admin
 *      (up to 4 instances of 1 vCPU), the live and staging gateways, and
 *      the one-task jobs (the audit runner, a capture, a build carrier).
 *   2. The quality check gets what is left after one search index task, up
 *      to all of its runs at once ({@link MAX_LIGHTHOUSE_TASKS}): it runs
 *      on most Stages, and the editor waits for it.
 *   3. A search index that embeds more than one task's share gets the rest,
 *      at least one task: it is rare (a first index, a model change), long,
 *      and a narrower width only makes it take longer (its pieces survive
 *      a retry, index-shards.ts).
 *
 * From a quota of the reserve plus two tasks up (12 vCPU), both together
 * never exceed it, so Caelo's own jobs never compete with each other or
 * with the services for it. The job definitions carry
 * no `parallelism` (audit-job-setup.ts): the width is the `taskCount` the
 * admin asks for, so a raised quota is used from the next Stage on,
 * without an update.
 */

import { RUN_CPU_QUOTA_METRIC } from "@caelo-cms/shared";
import { z } from "zod";
import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";

/**
 * The most tasks one attempt runs (Cloud Run `taskCount`), whatever the
 * quota. The index job asks for more than one when a build has more
 * passages to embed than one task embeds in a few minutes; 32 tasks of 2
 * vCPU embed the about 800,000 passages of a 50,000-page site's first
 * index in about 25 minutes.
 */
export const MAX_JOB_TASKS = 32;

/** vCPU kept free for the services and the one-task jobs (see the file comment). */
export const RESERVED_VCPU = 8;

/** vCPU of one Lighthouse task (provisioning audit-job-setup.ts `--cpu`). */
export const LIGHTHOUSE_TASK_VCPU = 2;

/** vCPU of one search index task (provisioning reporting-job-catalog.ts). */
export const INDEX_TASK_VCPU = 2;

/**
 * The most Lighthouse runs one batch of a quality check has: 5 pages of 3
 * runs (`QUALITY_AUDIT_PAGE_CAP` × `PERFORMANCE_RUNS`, ops/quality/
 * lifecycle.ts; a test pins the product). A confirmation batch has fewer.
 */
export const MAX_LIGHTHOUSE_TASKS = 15;

/** What the project's quota lets run at once, and what would run everything at full width. */
export interface RunCapacity {
  readonly projectId: string;
  readonly region: string;
  /** The project's Cloud Run CPU quota in the region, in vCPU; null when Google sets no limit. */
  readonly quotaVcpu: number | null;
  readonly reservedVcpu: number;
  /** Lighthouse runs at once, 1 to {@link MAX_LIGHTHOUSE_TASKS}. */
  readonly lighthouseTasks: number;
  /** Tasks a large search index build may use, 1 to `MAX_JOB_TASKS`. */
  readonly indexTasks: number;
  /** The quota at which every Lighthouse run of a check runs at once, next to one index task. */
  readonly checkFullSpeedVcpu: number;
  /** The quota at which a check and the widest index build both run at full width. */
  readonly fullSpeedVcpu: number;
}

/** The serializable part of {@link RunCapacity} a job order carries. */
export const runCapacitySchema = z
  .object({
    projectId: z.string().min(1).max(64),
    region: z.string().min(1).max(64),
    quotaVcpu: z.number().int().nonnegative().nullable(),
    reservedVcpu: z.number().int().nonnegative(),
    lighthouseTasks: z.number().int().min(1).max(MAX_LIGHTHOUSE_TASKS),
    indexTasks: z.number().int().min(1).max(MAX_JOB_TASKS),
    checkFullSpeedVcpu: z.number().int().positive(),
    fullSpeedVcpu: z.number().int().positive(),
  })
  .strict();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The widths a quota allows. Pure; exported for tests.
 *
 * @param quotaVcpu - the region's Cloud Run CPU quota in vCPU, null for none.
 */
export function planRunCapacity(
  projectId: string,
  region: string,
  quotaVcpu: number | null,
): RunCapacity {
  const checkFullSpeedVcpu =
    RESERVED_VCPU + MAX_LIGHTHOUSE_TASKS * LIGHTHOUSE_TASK_VCPU + INDEX_TASK_VCPU;
  const fullSpeedVcpu = quotaForIndexTasks(MAX_JOB_TASKS);
  const spare = quotaVcpu === null ? Number.POSITIVE_INFINITY : quotaVcpu - RESERVED_VCPU;
  const lighthouseTasks = clamp(
    Math.floor((spare - INDEX_TASK_VCPU) / LIGHTHOUSE_TASK_VCPU),
    1,
    MAX_LIGHTHOUSE_TASKS,
  );
  const indexTasks = clamp(
    Math.floor((spare - lighthouseTasks * LIGHTHOUSE_TASK_VCPU) / INDEX_TASK_VCPU),
    1,
    MAX_JOB_TASKS,
  );
  return {
    projectId,
    region,
    quotaVcpu,
    reservedVcpu: RESERVED_VCPU,
    lighthouseTasks,
    indexTasks,
    checkFullSpeedVcpu,
    fullSpeedVcpu,
  };
}

/**
 * The quota at which a search index build runs on `tasks` next to a quality
 * check at full speed: what an Owner asks for to make that build faster.
 */
export function quotaForIndexTasks(tasks: number): number {
  return RESERVED_VCPU + MAX_LIGHTHOUSE_TASKS * LIGHTHOUSE_TASK_VCPU + tasks * INDEX_TASK_VCPU;
}

export { RUN_CPU_QUOTA_METRIC };

const quotaMetricSchema = z.object({
  consumerQuotaLimits: z
    .array(
      z.object({
        unit: z.string(),
        quotaBuckets: z
          .array(
            z.object({
              // int64 as a JSON string; "-1" = no limit.
              effectiveLimit: z.string().regex(/^-?\d+$/),
              dimensions: z.record(z.string(), z.string()).optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * The region's limit in vCPU from a Service Usage `consumerQuotaMetrics`
 * answer, null for no limit. Pure; exported for tests.
 *
 * The bucket for the region wins; the bucket without dimensions is the
 * limit of every region that has no bucket of its own (the API's meaning
 * of an empty `dimensions`, not a guess).
 *
 * @throws when the answer has no regional limit at all.
 */
export function regionQuotaVcpu(answer: unknown, region: string): number | null {
  const metric = quotaMetricSchema.parse(answer);
  const limit = metric.consumerQuotaLimits.find((l) => l.unit.includes("{region}"));
  if (!limit) {
    throw new Error(`${RUN_CPU_QUOTA_METRIC} has no per-region limit in Google's answer`);
  }
  const own = limit.quotaBuckets.find((b) => b.dimensions?.region === region);
  const general = limit.quotaBuckets.find((b) => Object.keys(b.dimensions ?? {}).length === 0);
  const bucket = own ?? general;
  if (!bucket) {
    throw new Error(`${RUN_CPU_QUOTA_METRIC} has no limit for region ${region} in Google's answer`);
  }
  const milli = Number(bucket.effectiveLimit);
  return milli < 0 ? null : Math.floor(milli / 1000);
}

const JOB_NAME = /^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/[^/]+$/;

/**
 * Read the project's Cloud Run CPU quota and plan the widths from it. The
 * project and region come from a job's resource name, which every launcher
 * already holds. Needs `serviceusage.quotas.get` on the project (the
 * admin's account holds `roles/serviceusage.serviceUsageViewer`).
 *
 * @throws a message naming the grant when Google refuses the read.
 */
export async function readRunCapacity(
  jobName: string,
  deps: GoogleDeps = defaultGoogleDeps(),
): Promise<RunCapacity> {
  const m = JOB_NAME.exec(jobName);
  if (!m?.[1] || !m[2]) throw new Error(`not a Cloud Run job name: ${jobName}`);
  const [projectId, region] = [m[1], m[2]];
  const url = `https://serviceusage.googleapis.com/v1beta1/projects/${projectId}/services/run.googleapis.com/consumerQuotaMetrics/${encodeURIComponent(RUN_CPU_QUOTA_METRIC)}`;
  let answer: unknown;
  try {
    answer = await googleCall(deps, url, "GET");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `could not read the Cloud Run CPU quota of project ${projectId} (${message})${
        /HTTP 403/.test(message)
          ? " — the admin's service account needs roles/serviceusage.serviceUsageViewer on the project; run `cms-provision upgrade`"
          : ""
      }`,
    );
  }
  return planRunCapacity(projectId, region, regionQuotaVcpu(answer, region));
}

/**
 * Where an Owner asks Google for more: the project's quota page. The CPU
 * quota is the row "Total CPU allocation, per project per region" of
 * Cloud Run Admin API, filtered by {@link RUN_CPU_QUOTA_METRIC}.
 */
export function quotaConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/iam-admin/quotas?project=${encodeURIComponent(projectId)}`;
}

/** Whether the quota keeps a job narrower than its full width. */
export function capacityLimited(c: RunCapacity): boolean {
  return c.quotaVcpu !== null && c.quotaVcpu < c.fullSpeedVcpu;
}

/** The env var naming the Lighthouse job, whose resource name gives the project and region. */
const AUDIT_JOB_ENV_VAR = "CAELO_AUDIT_JOB";

/**
 * This install's capacity for Settings → Deployments: null where the
 * provider has no Cloud Run quota (self-hosted, and AWS / Azure until
 * their jobs exist).
 *
 * @throws a message with the next step when the job is not configured or
 *   Google refuses the read.
 */
export async function readInstallRunCapacity(
  env: Record<string, string | undefined> = process.env,
  deps?: GoogleDeps,
): Promise<RunCapacity | null> {
  if (env.CAELO_PROVIDER !== "gcp" && env.CAELO_PROVIDER !== "gcp-firebase") return null;
  const job = env[AUDIT_JOB_ENV_VAR]?.trim();
  if (!job) {
    throw new Error(
      `${AUDIT_JOB_ENV_VAR} is not set on the admin, so it cannot tell which project's quota to read — run \`cms-provision upgrade\``,
    );
  }
  return readRunCapacity(job, deps);
}
