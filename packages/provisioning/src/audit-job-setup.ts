// SPDX-License-Identifier: MPL-2.0

/**
 * #875 — set up (and converge) the parallel quality-audit job on a Google
 * Cloud install (`gcp`, `gcp-firebase`). Run by the wizard after `pulumi up`
 * and by `cms-provision upgrade`'s converge, both as the operator's own
 * gcloud identity. App-roll moves the job's image with the admin's
 * (upgrade/app-roll.ts), because the job runs the admin image.
 *
 * Why a separate job at all (CLAUDE.md §11.B Tier 5 exception): Lighthouse
 * is CPU-bound and simulates the CPU slowdown from observed task durations,
 * so a run that shares a CPU with another run or with the editor's chat
 * measures that interference too. One task per run measures the page alone,
 * and all runs finish in about the time of one.
 *
 * Why the CLI owns it and not the stacks: `upgrade` never runs Pulumi, so
 * existing installs get the job only from here, and a bucket or job both
 * Pulumi and `upgrade` create would collide on the next wizard re-run (the
 * same reasoning as operator-access.ts and upgrader-setup.ts).
 *
 * Trust boundary. The job's service account, `caelo-<env>-audit`, holds:
 *
 *   - `roles/storage.objectCreator` on the audit results bucket — create
 *     only: it can neither read results back nor overwrite one;
 *   - on `gcp` only, `roles/storage.objectViewer` on the staging and static
 *     buckets: it serves the staged build to its own browser, as the admin's
 *     audit does (admin-core quality/staged-origin.ts). gcp-firebase audits
 *     the public preview channel and needs no bucket;
 *   - `roles/logging.logWriter`.
 *
 * Nothing else: no Secret Manager, no Cloud SQL, and no VPC egress, so the
 * database's private IP is not even routable from a task. Plugin data on a
 * page comes the way any visitor gets it: the task's browser calls the
 * site's public `/api/*` (the gateway, behind Cloud Armor) over the
 * internet. The admin's run
 * SA may run the job WITH overrides (`roles/run.jobsExecutorWithOverrides`:
 * it passes each audit's batch of orders), read its executions
 * (`roles/run.viewer`) and read the results bucket. Unlike the
 * operator-access and upgrader jobs, overrides are acceptable here: a
 * compromised admin can make the job load other URLs, but the job holds
 * nothing worth taking. {@link AUDIT_FORBIDDEN_ROLES} names that line; the
 * tests assert no grant crosses it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  auditJobName,
  auditServiceAccountEmail,
  auditServiceAccountId,
  gcpBucketName,
  runServiceAccountEmail,
} from "./gcp-names.js";
import { readAdminConfig } from "./migration-runner.js";
import type { GcpProvider } from "./stack-contract.js";

/** Where the admin image ships the task's entry point. */
export const AUDIT_TASK_SCRIPT = "/app/packages/admin-core/src/quality/audit-task.ts";

/** How many audit tasks run at once by default: 5 pages x 3 runs. */
export const AUDIT_PARALLELISM_DEFAULT = 15;

/**
 * Per task: container start, browser start, CPU benchmark and one
 * Lighthouse run. Matches admin-core `parallelAuditTimeoutMs`, which the
 * admin also passes per execution.
 */
const TASK_TIMEOUT = "5m";

/**
 * Roles the audit job's identity must never hold anywhere. Prefix matches
 * (`roles/secretmanager.` = every Secret Manager role).
 */
export const AUDIT_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/run.",
  "roles/iam.",
  "roles/secretmanager.",
  "roles/cloudsql.",
  "roles/compute.",
  "roles/resourcemanager.",
  "roles/storage.admin",
  "roles/storage.objectAdmin",
  "roles/storage.objectUser",
] as const;

/** Delete results after a day: the admin reads them within minutes. */
export const AUDIT_RESULTS_LIFECYCLE = {
  rule: [{ action: { type: "Delete" }, condition: { age: 1 } }],
};

export interface AuditJobTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** The admin image the job runs, digest-pinned (`…/admin@sha256:…`). */
  readonly adminImageRef: string;
  /**
   * Tasks at once (`auditParallelism`, 1–15). Absent on converge: an
   * existing job keeps the value it has, so an operator's choice survives
   * `upgrade`.
   */
  readonly parallelism?: number;
}

export type AuditJobResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/** Ensure the audit job and everything it needs. Never throws for a gcloud failure. */
export async function ensureAuditJob(
  target: AuditJobTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<AuditJobResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env, provider } = target;
  const project = `--project=${projectId}`;
  const sa = auditServiceAccountEmail(projectId, env);
  const member = `serviceAccount:${sa}`;
  const runSaMember = `serviceAccount:${runServiceAccountEmail(projectId, env)}`;
  const job = auditJobName(env);
  const results = gcpBucketName(projectId, env, "audit-results");
  const resultsUrl = `gs://${results}`;
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): AuditJobResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  if (!/@sha256:[0-9a-f]{64}$/.test(target.adminImageRef)) {
    return {
      ok: false,
      done,
      error: `the audit job's image must be pinned by digest, got ${target.adminImageRef}`,
    };
  }
  if (
    target.parallelism !== undefined &&
    (!Number.isInteger(target.parallelism) || target.parallelism < 1 || target.parallelism > 15)
  ) {
    return {
      ok: false,
      done,
      error: `auditParallelism must be a whole number from 1 to 15, got ${target.parallelism}`,
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
      auditServiceAccountId(env),
      "--display-name=Caelo quality audit",
      "--description=Runs the quality audit's Lighthouse runs in parallel; reads the staged build, writes audit results, nothing else.",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) return fail(`create ${sa}`, create);
  }
  done.push(`service account ${sa}`);

  // 2. The results bucket: private, results deleted after a day.
  const owned = await run(["storage", "buckets", "list", project, "--format=value(name)"]);
  if (!owned.ok) return fail(`list the buckets of project ${projectId}`, owned);
  const names = owned.stdout.split("\n").map((l) =>
    l
      .trim()
      .replace(/^gs:\/\//, "")
      .replace(/\/$/, ""),
  );
  if (!names.includes(results)) {
    const created = await run([
      "storage",
      "buckets",
      "create",
      resultsUrl,
      project,
      `--location=${region}`,
      "--default-storage-class=STANDARD",
      "--uniform-bucket-level-access",
      "--public-access-prevention",
      "--soft-delete-duration=0",
    ]);
    if (!created.ok) {
      return {
        ok: false,
        done,
        error: /already exists|409/i.test(created.stderr)
          ? `${resultsUrl} exists but does not belong to project ${projectId}; delete or rename that bucket, this install needs the name`
          : `create ${resultsUrl}: ${created.stderr.trim()}`,
      };
    }
  }
  // A private directory (mkdtemp, mode 700): no other local user can swap
  // the file between write and read.
  const dir = mkdtempSync(join(tmpdir(), "caelo-audit-"));
  try {
    const file = join(dir, "lifecycle.json");
    writeFileSync(file, JSON.stringify(AUDIT_RESULTS_LIFECYCLE), { mode: 0o600 });
    const lifecycle = await run([
      "storage",
      "buckets",
      "update",
      resultsUrl,
      project,
      `--lifecycle-file=${file}`,
    ]);
    if (!lifecycle.ok) return fail(`set the lifecycle of ${resultsUrl}`, lifecycle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  done.push(`bucket ${resultsUrl} (results deleted after 1 day)`);

  // 3. Bucket grants: the job creates results and (gcp) reads the build;
  //    the admin reads results.
  const bucketGrants: { bucket: string; member: string; role: string; why: string }[] = [
    { bucket: results, member, role: "roles/storage.objectCreator", why: "tasks write results" },
    ...(provider === "gcp"
      ? (["staging", "static"] as const).map((b) => ({
          bucket: gcpBucketName(projectId, env, b),
          member,
          role: "roles/storage.objectViewer",
          why: "tasks serve the staged build to their browser",
        }))
      : []),
    {
      bucket: results,
      member: runSaMember,
      role: "roles/storage.objectViewer",
      why: "the admin reads the results",
    },
  ];
  for (const g of bucketGrants) {
    const r = await retry([
      "storage",
      "buckets",
      "add-iam-policy-binding",
      `gs://${g.bucket}`,
      `--member=${g.member}`,
      `--role=${g.role}`,
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant ${g.role} on gs://${g.bucket} (${g.why})`, r);
    done.push(`${g.member === member ? "audit job" : "admin"}: ${g.role} on gs://${g.bucket}`);
  }

  // 4. Logs.
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
  if (!logs.ok) return fail("grant the audit job roles/logging.logWriter", logs);
  done.push("audit job: roles/logging.logWriter on the project");

  // 5. The job: the admin image, its own SA, no secrets, no VPC.
  const envVars = [
    `CAELO_PROVIDER=${provider}`,
    `CAELO_AUDIT_RESULTS_BUCKET=${results}`,
    ...(provider === "gcp"
      ? [
          `CAELO_STAGING_BUCKET=${gcpBucketName(projectId, env, "staging")}`,
          `CAELO_STATIC_BUCKET=${gcpBucketName(projectId, env, "static")}`,
        ]
      : []),
  ];
  const deploy = await run([
    "run",
    "jobs",
    "deploy",
    job,
    `--image=${target.adminImageRef}`,
    `--region=${region}`,
    project,
    `--service-account=${sa}`,
    "--command=bun",
    `--args=--bun,${AUDIT_TASK_SCRIPT}`,
    `--set-env-vars=${envVars.join(",")}`,
    "--max-retries=0",
    `--task-timeout=${TASK_TIMEOUT}`,
    // Lighthouse wants two cores: the browser and the trace processing.
    "--cpu=2",
    "--memory=2Gi",
    ...(target.parallelism !== undefined ? [`--parallelism=${target.parallelism}`] : []),
    "--quiet",
  ]);
  if (!deploy.ok) return fail(`deploy job ${job}`, deploy);
  done.push(`job ${job} (${target.adminImageRef.split("@")[1]?.slice(0, 19)}...)`);

  // 6. The admin may run it with its batch and read its executions.
  for (const role of ["roles/run.jobsExecutorWithOverrides", "roles/run.viewer"]) {
    const r = await retry([
      "run",
      "jobs",
      "add-iam-policy-binding",
      job,
      `--region=${region}`,
      project,
      `--member=${runSaMember}`,
      `--role=${role}`,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the admin ${role} on ${job}`, r);
    done.push(`admin: ${role} on ${job}`);
  }
  return { ok: true, done };
}

/**
 * {@link ensureAuditJob}'s image: the deployed admin's, so the job runs the
 * code the admin runs.
 */
export async function resolveAdminImage(
  opts: { readonly projectId: string; readonly region: string; readonly env: string },
  deps: { run?: GcloudRunner } = {},
): Promise<{ ok: true; imageRef: string } | { ok: false; error: string }> {
  const cfg = await readAdminConfig(opts, deps.run ?? defaultGcloud);
  if (!cfg)
    return {
      ok: false,
      error: "could not read the admin service's image (is the admin deployed?)",
    };
  return { ok: true, imageRef: cfg.imageRef };
}
