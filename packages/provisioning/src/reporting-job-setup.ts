// SPDX-License-Identifier: MPL-2.0

/**
 * #1359 (#1140 category A) — set up (and converge) a reporting job on a
 * Google Cloud install (`gcp`, `gcp-firebase`): a Cloud Run job that runs
 * long, bounded work (a Stage's quality audit, #1359; a site import's crawl,
 * #1360; a Stage's collection index and a plugin's batch run, epic #1644)
 * outside the admin and reports back to it by request, so the admin
 * only works inside requests (CLAUDE.md §11.B Tier 5) — or, the build
 * carrier (#1574), holds the request a build runs in. Run by the wizard
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
 * plus its kind's own grants, declared by its entry in reporting-job-catalog.ts
 * (the audit runner reads the staged build and the Lighthouse results and
 * starts the Lighthouse tasks; the collection index job reads and creates
 * files in the staging collection store; the site-import crawler, the build
 * carrier and the plugin batch job have none).
 * Nothing else: no Secret Manager, no Cloud SQL, no VPC egress. Passing IAP
 * reaches nothing by itself: the admin's report endpoint takes a report of
 * a kind only from that kind's account AND with the token the admin minted
 * for the running attempt, and only that attempt's reports
 * (admin-core reporting-jobs/dispatch.ts); every other admin route still
 * needs a session, the internal token or the scheduler's identity, which
 * the job has none of. IAP access goes only to jobs that run no browser
 * and execute nothing they fetch; every render stays in the capture job
 * and the Lighthouse tasks, which have no IAP access (capture-job-setup.ts).
 * The plugin batch job runs plugin code, but only an Owner-approved
 * artifact, in the Deno sandbox (no network, no files, no env): the
 * plugin reaches the admin only through the job's host side, report by
 * report, never with the job's credential.
 *
 * The admin's run SA may run the job WITH overrides (it passes each
 * attempt's order: the work, the attempt, its token, the admin's URL) and
 * read its executions. {@link REPORTING_JOB_FORBIDDEN_ROLES} names the line;
 * the tests assert no grant crosses it, but for the two reviewed exceptions
 * a kind declares itself: the jobs it starts ({@link ReportingJobSpec.runJobs})
 * and the buckets it creates files in ({@link ReportingJobSpec.writeBuckets}).
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { runServiceAccountEmail } from "./gcp-names.js";
import { type IapResource, iapResourceArgs } from "./mcp-iap.js";
import {
  type ReportingJobKindEntry,
  type ReportingJobPlace,
  type ReportingJobSpec,
  reportingJobSpec,
} from "./reporting-job-catalog.js";

/** Where the admin image ships every reporting job's entry point. */
export const REPORTING_JOB_SCRIPT = "/app/packages/admin-core/src/reporting-jobs/job-entry.ts";

/**
 * Roles a reporting job's identity must never hold anywhere. Prefix matches
 * (`roles/secretmanager.` = every Secret Manager role). `roles/run.` roles
 * are allowed only on a job a kind names in {@link ReportingJobSpec.runJobs}
 * (the audit runner starts the Lighthouse tasks), and
 * `roles/storage.objectCreator` only on a bucket a kind names in
 * {@link ReportingJobSpec.writeBuckets} (the collection index job writes
 * its releases); the tests assert both.
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

/** Where one install's reporting job goes. */
export interface ReportingJobTarget extends ReportingJobPlace {
  /** The admin image the job runs, digest-pinned (`…/admin@sha256:…`). */
  readonly adminImageRef: string;
  /** The admin's IAP resource (the service on gcp-firebase, the LB backend on gcp). */
  readonly resource: IapResource;
}

export type ReportingJobResult =
  | { readonly ok: true; readonly done: string[]; readonly serviceAccount: string }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

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

  // 5b. Where its kind creates files (create only: no overwrite, no delete).
  for (const b of spec.writeBuckets) {
    const r = await retry([
      "storage",
      "buckets",
      "add-iam-policy-binding",
      `gs://${b.bucket}`,
      `--member=${member}`,
      "--role=roles/storage.objectCreator",
      "--condition=None",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant roles/storage.objectCreator on gs://${b.bucket} (${b.why})`, r);
    done.push(`${spec.label}: roles/storage.objectCreator on gs://${b.bucket}`);
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

/**
 * Ensure the job of one catalog kind (reporting-job-catalog.ts): what the
 * wizard and every converge run for each entry, in catalog order.
 */
export function ensureReportingJobKind(
  entry: ReportingJobKindEntry,
  target: ReportingJobTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ReportingJobResult> {
  return ensureReportingJob(target, reportingJobSpec(entry, target), deps);
}
