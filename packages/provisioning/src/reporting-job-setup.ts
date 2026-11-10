// SPDX-License-Identifier: MPL-2.0

/**
 * #1359 (#1140 category A) — set up (and converge) a reporting job on a
 * Google Cloud install (`gcp`, `gcp-firebase`): a Cloud Run job that runs
 * long, bounded work (a Stage's quality audit, #1359; a site import's crawl,
 * #1360) outside the admin and reports back to it by request, so the admin
 * only works inside requests (CLAUDE.md §11.B Tier 5). Run by the wizard
 * after `pulumi up` and by `cms-provision upgrade`'s converge (and the
 * converge job), as the operator's or the provisioner's identity. App-roll
 * moves the job's image with the admin's (upgrade/admin-image-jobs.ts):
 * the job runs the admin image's `reporting-jobs/job-entry.ts`.
 *
 * Why the CLI owns it and not the stacks: the same as audit-job-setup.ts —
 * `upgrade` never runs Pulumi, so existing installs get it only from here.
 *
 * Trust boundary. Every reporting job runs as its own service account,
 * which holds — shared by every kind ({@link ensureReportingJob}):
 *
 *   - `roles/iam.serviceAccountTokenCreator` on ITSELF only: it signs the
 *     IAP credential it reports with (IAM signJwt), as the scheduler does;
 *   - `roles/iap.httpsResourceAccessor` on the admin's IAP resource (the
 *     operator-access sync job keeps it there, operator-access.ts);
 *   - `roles/logging.logWriter`.
 *
 * plus its kind's own grants (the audit runner: {@link auditRunnerJobSpec};
 * the site-import crawler has none, {@link importCrawlJobSpec}).
 * Nothing else: no Secret Manager, no Cloud SQL, no VPC egress. Passing IAP
 * reaches nothing by itself: the admin's report endpoint takes a report of
 * a kind only from that kind's account AND with the token the admin minted
 * for the running attempt, and only that attempt's reports
 * (admin-core reporting-jobs/dispatch.ts); every other admin route still
 * needs a session, the internal token or the scheduler's identity, which
 * the job has none of. IAP access goes only to jobs that run no browser
 * and execute nothing they fetch; every render stays in the capture job
 * and the Lighthouse tasks, which have no IAP access (capture-job-setup.ts).
 *
 * The admin's run SA may run the job WITH overrides (it passes each
 * attempt's order: the work, the attempt, its token, the admin's URL) and
 * read its executions. {@link REPORTING_JOB_FORBIDDEN_ROLES} names the line;
 * the tests assert no grant crosses it.
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  auditJobName,
  auditJobResource,
  auditRunnerJobName,
  auditRunnerServiceAccountId,
  gcpBucketName,
  importCrawlJobName,
  importCrawlServiceAccountId,
  runServiceAccountEmail,
} from "./gcp-names.js";
import { type IapResource, iapResourceArgs } from "./mcp-iap.js";
import type { GcpProvider } from "./stack-contract.js";

/** Where the admin image ships every reporting job's entry point. */
export const REPORTING_JOB_SCRIPT = "/app/packages/admin-core/src/reporting-jobs/job-entry.ts";

/**
 * Roles a reporting job's identity must never hold anywhere. Prefix matches
 * (`roles/secretmanager.` = every Secret Manager role). `roles/run.` roles
 * are allowed only on a job a kind names in {@link ReportingJobSpec.runJobs}
 * (the audit runner starts the Lighthouse tasks); the tests assert that.
 */
export const REPORTING_JOB_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/viewer",
  "roles/iam.serviceAccountUser",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.securityAdmin",
  "roles/iap.admin",
  "roles/iap.settingsAdmin",
  "roles/secretmanager.",
  "roles/cloudsql.",
  "roles/compute.",
  "roles/resourcemanager.",
  "roles/storage.admin",
  "roles/storage.objectAdmin",
  "roles/storage.objectUser",
  "roles/storage.objectCreator",
  "roles/run.admin",
  "roles/run.developer",
  "roles/run.invoker",
] as const;

/** What one kind of reporting job needs beyond the shared grants. */
export interface ReportingJobSpec {
  /** How the CLI names it ("quality-audit runner"). */
  readonly label: string;
  readonly jobName: string;
  readonly serviceAccountId: string;
  readonly displayName: string;
  readonly description: string;
  /** The job's env (`KEY=value`; never a secret). */
  readonly env: readonly string[];
  readonly cpu: string;
  readonly memory: string;
  /** One execution's ceiling (admin-core protocol.ts `JOB_TIMING.maxRunSeconds`). */
  readonly taskTimeoutSeconds: number;
  /** Read-only bucket access it needs, each with the reason. */
  readonly readBuckets: readonly { readonly bucket: string; readonly why: string }[];
  /** Jobs it starts itself, with its order as an override (and reads their executions). */
  readonly runJobs: readonly { readonly job: string; readonly why: string }[];
}

/** Where one install's reporting job goes. */
export interface ReportingJobTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** The admin image the job runs, digest-pinned (`…/admin@sha256:…`). */
  readonly adminImageRef: string;
  /** The admin's IAP resource (the service on gcp-firebase, the LB backend on gcp). */
  readonly resource: IapResource;
}

export type ReportingJobResult =
  | { readonly ok: true; readonly done: string[]; readonly serviceAccount: string }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/**
 * The audit runner (#1359): the whole quality audit of a Stage. It serves
 * the staged build from its staging slot to its own findings checks, starts
 * the Lighthouse tasks on the audit job (#875) and reads their results.
 */
export function auditRunnerJobSpec(
  target: Pick<ReportingJobTarget, "provider" | "projectId" | "region" | "env">,
): ReportingJobSpec {
  const { projectId, region, env, provider } = target;
  const staging = gcpBucketName(projectId, env, "staging");
  const results = gcpBucketName(projectId, env, "audit-results");
  return {
    label: "quality-audit runner",
    jobName: auditRunnerJobName(env),
    serviceAccountId: auditRunnerServiceAccountId(env),
    displayName: "Caelo quality-audit runner",
    description:
      "Runs a Stage's quality audit and reports to the admin; reads the staged build and the Lighthouse results, starts the Lighthouse tasks, nothing else.",
    env: [
      `CAELO_PROVIDER=${provider}`,
      `CAELO_STAGING_BUCKET=${staging}`,
      `CAELO_AUDIT_JOB=${auditJobResource(projectId, region, env)}`,
      `CAELO_AUDIT_RESULTS_BUCKET=${results}`,
    ],
    cpu: "1",
    memory: "2Gi",
    // admin-core JOB_TIMING.quality_audit.maxRunSeconds.
    taskTimeoutSeconds: 3600,
    readBuckets: [
      { bucket: staging, why: "it serves the staged build to the findings checks" },
      { bucket: results, why: "it reads the Lighthouse tasks' results" },
    ],
    runJobs: [{ job: auditJobName(env), why: "it starts the Lighthouse tasks" }],
  };
}

/**
 * The site-import crawler (#1360): one site import's crawl. It reads
 * third-party pages, so it holds nothing beyond the shared grants: no
 * bucket, no other job. It fetches robots.txt and sitemaps itself, through
 * the SSRF guard; every page render is the admin's, which starts the
 * capture job and keeps the screenshot, so the crawler never runs a
 * browser and never touches the capture job or its bucket.
 */
export function importCrawlJobSpec(
  target: Pick<ReportingJobTarget, "provider" | "env">,
): ReportingJobSpec {
  return {
    label: "site-import crawler",
    jobName: importCrawlJobName(target.env),
    serviceAccountId: importCrawlServiceAccountId(target.env),
    displayName: "Caelo site-import crawler",
    description:
      "Crawls a site the Owner approved for import and reports each page to the admin; fetches robots.txt and sitemaps through the SSRF guard, nothing else.",
    env: [`CAELO_PROVIDER=${target.provider}`],
    cpu: "1",
    // The frontier and up to four rendered pages' HTML at once.
    memory: "2Gi",
    // admin-core JOB_TIMING.site_import.maxRunSeconds: a longer crawl goes
    // on in the next attempt, from its checkpoint.
    taskTimeoutSeconds: 6 * 3600,
    readBuckets: [],
    runJobs: [],
  };
}

/** Ensure a reporting job and everything it needs. Never throws for a gcloud failure. */
export async function ensureReportingJob(
  target: ReportingJobTarget,
  spec: ReportingJobSpec,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ReportingJobResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region } = target;
  const project = `--project=${projectId}`;
  const sa = `${spec.serviceAccountId}@${projectId}.iam.gserviceaccount.com`;
  const member = `serviceAccount:${sa}`;
  const runSaMember = `serviceAccount:${runServiceAccountEmail(projectId, target.env)}`;
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): ReportingJobResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  if (!/@sha256:[0-9a-f]{64}$/.test(target.adminImageRef)) {
    return {
      ok: false,
      done,
      error: `the ${spec.label}'s image must be pinned by digest, got ${target.adminImageRef}`,
    };
  }

  // 1. The job's own service account.
  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    sa,
    project,
    "--format=value(email)",
  ]);
  if (!describe.ok) {
    const create = await run([
      "iam",
      "service-accounts",
      "create",
      spec.serviceAccountId,
      `--display-name=${spec.displayName}`,
      `--description=${spec.description}`,
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) return fail(`create ${sa}`, create);
  }
  done.push(`service account ${sa}`);

  // 2. It signs its IAP credential as itself, and nothing else of IAM.
  const self = await retry([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    sa,
    `--member=${member}`,
    "--role=roles/iam.serviceAccountTokenCreator",
    "--condition=None",
    project,
    "--quiet",
    "--format=none",
  ]);
  if (!self.ok) return fail(`let the ${spec.label} sign its IAP credential as itself`, self);
  done.push(`${spec.label}: roles/iam.serviceAccountTokenCreator on ${sa} (itself, signJwt)`);

  // 3. Logs.
  const logs = await retry([
    "projects",
    "add-iam-policy-binding",
    projectId,
    `--member=${member}`,
    "--role=roles/logging.logWriter",
    "--condition=None",
    "--quiet",
    "--format=none",
  ]);
  if (!logs.ok) return fail(`grant the ${spec.label} roles/logging.logWriter`, logs);
  done.push(`${spec.label}: roles/logging.logWriter on the project`);

  // 4. It passes the admin's IAP (its reports); the admin decides what a
  //    report may do.
  const iap = await retry([
    "iap",
    "web",
    "add-iam-policy-binding",
    ...iapResourceArgs(target.resource),
    `--member=${member}`,
    "--role=roles/iap.httpsResourceAccessor",
    "--condition=None",
    project,
    "--quiet",
  ]);
  if (!iap.ok) return fail(`let the ${spec.label} pass the admin's IAP`, iap);
  done.push(
    `${spec.label}: roles/iap.httpsResourceAccessor on the admin (${target.resource.service})`,
  );

  // 5. What its kind reads.
  for (const b of spec.readBuckets) {
    const r = await retry([
      "storage",
      "buckets",
      "add-iam-policy-binding",
      `gs://${b.bucket}`,
      `--member=${member}`,
      "--role=roles/storage.objectViewer",
      // A bucket whose policy already holds a conditional binding refuses an
      // unconditional grant in non-interactive mode unless it says so.
      "--condition=None",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant roles/storage.objectViewer on gs://${b.bucket} (${b.why})`, r);
    done.push(`${spec.label}: roles/storage.objectViewer on gs://${b.bucket}`);
  }

  // 6. The jobs its kind starts.
  for (const j of spec.runJobs) {
    for (const role of ["roles/run.jobsExecutorWithOverrides", "roles/run.viewer"]) {
      const r = await retry([
        "run",
        "jobs",
        "add-iam-policy-binding",
        j.job,
        `--region=${region}`,
        project,
        `--member=${member}`,
        `--role=${role}`,
        "--quiet",
        "--format=none",
      ]);
      if (!r.ok) return fail(`grant the ${spec.label} ${role} on ${j.job} (${j.why})`, r);
      done.push(`${spec.label}: ${role} on ${j.job}`);
    }
  }

  // 7. The job: the admin image, its own SA, no secrets, no VPC.
  const deploy = await run([
    "run",
    "jobs",
    "deploy",
    spec.jobName,
    `--image=${target.adminImageRef}`,
    `--region=${region}`,
    project,
    `--service-account=${sa}`,
    "--command=bun",
    `--args=--bun,${REPORTING_JOB_SCRIPT}`,
    `--set-env-vars=${spec.env.join(",")}`,
    // The backstop restarts a dead attempt with a fresh token; a Cloud Run
    // retry would replay the old one.
    "--max-retries=0",
    `--task-timeout=${spec.taskTimeoutSeconds}s`,
    `--cpu=${spec.cpu}`,
    `--memory=${spec.memory}`,
    "--quiet",
  ]);
  if (!deploy.ok) return fail(`deploy job ${spec.jobName}`, deploy);
  done.push(`job ${spec.jobName} (${target.adminImageRef.split("@")[1]?.slice(0, 19)}...)`);

  // 8. The admin may run it with each attempt's order and read its executions.
  for (const role of ["roles/run.jobsExecutorWithOverrides", "roles/run.viewer"]) {
    const r = await retry([
      "run",
      "jobs",
      "add-iam-policy-binding",
      spec.jobName,
      `--region=${region}`,
      project,
      `--member=${runSaMember}`,
      `--role=${role}`,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the admin ${role} on ${spec.jobName}`, r);
    done.push(`admin: ${role} on ${spec.jobName}`);
  }
  return { ok: true, done, serviceAccount: sa };
}

/** Ensure the quality-audit runner (#1359). */
export function ensureAuditRunnerJob(
  target: ReportingJobTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ReportingJobResult> {
  return ensureReportingJob(target, auditRunnerJobSpec(target), deps);
}

/** Ensure the site-import crawler (#1360). */
export function ensureImportCrawlJob(
  target: ReportingJobTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ReportingJobResult> {
  return ensureReportingJob(target, importCrawlJobSpec(target), deps);
}
