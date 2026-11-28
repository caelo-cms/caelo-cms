// SPDX-License-Identifier: MPL-2.0

/**
 * The project's Cloud Run CPU quota: how much the jobs and the services of
 * an install may run at once in its region.
 *
 * Cloud Run has one CPU quota per project and region ("Total CPU
 * allocation", `run.googleapis.com/cpu_allocation`, in milli vCPU). Every
 * running instance counts against it, services and job tasks alike, and a
 * job whose `parallelism` times its CPU exceeds it cannot even be created.
 * Projects created before 2026 have thousands of vCPU there; a new
 * project gets 20 (#1764). So no job definition carries a fixed
 * parallelism (audit-job-setup.ts), and the admin reads the quota when a
 * job that may wait starts; the capacity ledger (job-capacity/, #1776)
 * books every execution against what it leaves the jobs.
 */

import { RUN_CPU_QUOTA_METRIC } from "@caelo-cms/shared";
import { z } from "zod";
import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";

/**
 * The most tasks one piece of work runs at once, its lead and its helpers
 * together. 32 tasks of 2 vCPU embed the about 800,000 passages of a
 * 50,000-page site's first index in about 25 minutes.
 */
export const MAX_JOB_TASKS = 32;

/**
 * The most Lighthouse runs one batch of a quality check has: 5 pages of 3
 * runs (`QUALITY_AUDIT_PAGE_CAP` × `PERFORMANCE_RUNS`, ops/quality/
 * lifecycle.ts; a test pins the product). A confirmation batch has fewer.
 */
export const MAX_LIGHTHOUSE_TASKS = 15;

export { RUN_CPU_QUOTA_METRIC };

/** The project's quota in a region. */
export interface QuotaReading {
  readonly projectId: string;
  readonly region: string;
  /** In vCPU; null when Google sets no limit. */
  readonly quotaVcpu: number | null;
}

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
 * Read the project's Cloud Run CPU quota. The project and region come from
 * a job's resource name, which every launcher already holds. Needs
 * `serviceusage.quotas.get` on the project (the admin's account holds
 * `roles/serviceusage.serviceUsageViewer`).
 *
 * @throws a message naming the grant when Google refuses the read.
 */
export async function readRunQuota(
  jobName: string,
  deps: GoogleDeps = defaultGoogleDeps(),
): Promise<QuotaReading> {
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
  return { projectId, region, quotaVcpu: regionQuotaVcpu(answer, region) };
}

/**
 * Where an Owner asks Google for more: the project's quota page. The CPU
 * quota is the row "Total CPU allocation, per project per region" of
 * Cloud Run Admin API, filtered by {@link RUN_CPU_QUOTA_METRIC}.
 */
export function quotaConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/iam-admin/quotas?project=${encodeURIComponent(projectId)}`;
}

/** The env var naming the Lighthouse job, whose resource name gives the project and region. */
const AUDIT_JOB_ENV_VAR = "CAELO_AUDIT_JOB";

/**
 * This install's quota for Settings → Deployments: null where the provider
 * has no Cloud Run quota (self-hosted, and AWS / Azure until their jobs
 * exist).
 *
 * @throws a message with the next step when the job is not configured or
 *   Google refuses the read.
 */
export async function readInstallRunQuota(
  env: Record<string, string | undefined> = process.env,
  deps?: GoogleDeps,
): Promise<QuotaReading | null> {
  if (env.CAELO_PROVIDER !== "gcp" && env.CAELO_PROVIDER !== "gcp-firebase") return null;
  const job = env[AUDIT_JOB_ENV_VAR]?.trim();
  if (!job) {
    throw new Error(
      `${AUDIT_JOB_ENV_VAR} is not set on the admin, so it cannot tell which project's quota to read — run \`cms-provision upgrade\``,
    );
  }
  return readRunQuota(job, deps);
}
