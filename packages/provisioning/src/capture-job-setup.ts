// SPDX-License-Identifier: MPL-2.0

/**
 * #1217 — set up (and converge) the capture job on a Google Cloud install
 * (`gcp`, `gcp-firebase`): the short-lived Cloud Run job that runs every
 * server-side browser render (screenshot_page's server path, the external
 * page tools, the site-import crawl), one execution per render. Run by the
 * wizard after `pulumi up` and by `cms-provision upgrade`'s converge, both as
 * the operator's own gcloud identity. App-roll moves the job's image with the
 * admin's (upgrade/admin-image-jobs.ts), because the job runs the admin image
 * (which bundles Chromium, #428).
 *
 * Why a separate job at all (CLAUDE.md §11.B Tier 5, second exception after
 * the audit job): a headless Chromium costs 300–700 MB per render, and inside
 * the 2 GiB admin it was the most plausible cause of the OOM kill of
 * 2026-10-28 (#1209). In a job it costs the admin nothing.
 *
 * Why the CLI owns it and not the stacks: the same as audit-job-setup.ts —
 * `upgrade` never runs Pulumi.
 *
 * Trust boundary. The job renders untrusted pages (third-party sites, module
 * scripts in a preview), so its identity, `caelo-<env>-capture`, holds:
 *
 *   - `roles/storage.objectCreator` on the capture bucket, conditioned to the
 *     `out/` prefix — create results only: it cannot read, overwrite or list
 *     anything, nor write where the admin puts inputs;
 *   - `roles/logging.logWriter`.
 *
 * Nothing else: no read right anywhere (its input and the preview's media
 * arrive as V4 signed URLs the admin creates per capture, valid 5 minutes,
 * deleted with the capture), no Secret Manager, no Cloud SQL, no VPC egress,
 * and no IAP access to the admin — a browser exploit in the job reaches
 * nothing but the internet it already renders.
 *
 * The admin's run SA may run the job WITH overrides (it passes the order),
 * read its executions, use the capture bucket (`roles/storage.objectUser`:
 * write inputs, read results, delete both) and sign URLs as itself
 * (`roles/iam.serviceAccountTokenCreator` on its own account only: Cloud Run
 * holds no key, so V4 signing goes through IAM signBlob; the admin can mint
 * its own tokens through the metadata server already, so this widens
 * nothing). {@link CAPTURE_FORBIDDEN_ROLES} names the job's line; the tests
 * assert no grant crosses it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  captureJobName,
  captureServiceAccountEmail,
  captureServiceAccountId,
  gcpBucketName,
  runServiceAccountEmail,
} from "./gcp-names.js";
import type { GcpProvider } from "./stack-contract.js";

/** Where the admin image ships the task's entry point. */
export const CAPTURE_TASK_SCRIPT = "/app/packages/admin-core/src/capture/capture-task.ts";

/** Per execution: container start, browser start and one render. */
const TASK_TIMEOUT = "3m";

/**
 * Roles the capture job's identity must never hold anywhere. Prefix matches
 * (`roles/secretmanager.` = every Secret Manager role). Unlike the audit job
 * it reads nothing, so every storage read role is on the list too.
 */
export const CAPTURE_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/viewer",
  "roles/run.",
  "roles/iam.",
  "roles/iap.",
  "roles/secretmanager.",
  "roles/cloudsql.",
  "roles/compute.",
  "roles/resourcemanager.",
  "roles/storage.admin",
  "roles/storage.objectAdmin",
  "roles/storage.objectUser",
  "roles/storage.objectViewer",
  "roles/storage.legacy",
] as const;

/** Inputs and results are deleted by the admin; the lifecycle catches leftovers. */
export const CAPTURE_BUCKET_LIFECYCLE = {
  rule: [{ action: { type: "Delete" }, condition: { age: 1 } }],
};

/** The IAM condition that confines the job's create right to `out/`. */
export function captureResultsCondition(bucket: string): string {
  return `expression=resource.name.startsWith("projects/_/buckets/${bucket}/objects/out/"),title=capture-results-only,description=The capture job creates its results under out/ and nothing else`;
}

export interface CaptureJobTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** The admin image the job runs, digest-pinned (`…/admin@sha256:…`). */
  readonly adminImageRef: string;
}

export type CaptureJobResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/** Ensure the capture job and everything it needs. Never throws for a gcloud failure. */
export async function ensureCaptureJob(
  target: CaptureJobTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<CaptureJobResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env, provider } = target;
  const project = `--project=${projectId}`;
  const sa = captureServiceAccountEmail(projectId, env);
  const member = `serviceAccount:${sa}`;
  const runSa = runServiceAccountEmail(projectId, env);
  const runSaMember = `serviceAccount:${runSa}`;
  const job = captureJobName(env);
  const bucket = gcpBucketName(projectId, env, "capture");
  const bucketUrl = `gs://${bucket}`;
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): CaptureJobResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  if (!/@sha256:[0-9a-f]{64}$/.test(target.adminImageRef)) {
    return {
      ok: false,
      done,
      error: `the capture job's image must be pinned by digest, got ${target.adminImageRef}`,
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
      captureServiceAccountId(env),
      "--display-name=Caelo capture",
      "--description=Runs server-side browser renders (screenshots); creates capture results, nothing else.",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) return fail(`create ${sa}`, create);
  }
  done.push(`service account ${sa}`);

  // 2. The capture bucket: private, everything deleted after a day.
  const owned = await run(["storage", "buckets", "list", project, "--format=value(name)"]);
  if (!owned.ok) return fail(`list the buckets of project ${projectId}`, owned);
  const names = owned.stdout.split("\n").map((l) =>
    l
      .trim()
      .replace(/^gs:\/\//, "")
      .replace(/\/$/, ""),
  );
  if (!names.includes(bucket)) {
    const created = await run([
      "storage",
      "buckets",
      "create",
      bucketUrl,
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
          ? `${bucketUrl} exists but does not belong to project ${projectId}; delete or rename that bucket, this install needs the name`
          : `create ${bucketUrl}: ${created.stderr.trim()}`,
      };
    }
  }
  // A private directory (mkdtemp, mode 700): no other local user can swap
  // the file between write and read.
  const dir = mkdtempSync(join(tmpdir(), "caelo-capture-"));
  try {
    const file = join(dir, "lifecycle.json");
    writeFileSync(file, JSON.stringify(CAPTURE_BUCKET_LIFECYCLE), { mode: 0o600 });
    const lifecycle = await run([
      "storage",
      "buckets",
      "update",
      bucketUrl,
      project,
      `--lifecycle-file=${file}`,
    ]);
    if (!lifecycle.ok) return fail(`set the lifecycle of ${bucketUrl}`, lifecycle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  done.push(`bucket ${bucketUrl} (objects deleted after 1 day)`);

  // 3. Bucket grants: the job creates results under out/; the admin writes
  //    inputs, reads results and deletes both.
  const bucketGrants: { member: string; role: string; condition?: string; why: string }[] = [
    {
      member,
      role: "roles/storage.objectCreator",
      condition: captureResultsCondition(bucket),
      why: "the job writes its result under out/",
    },
    {
      member: runSaMember,
      role: "roles/storage.objectUser",
      why: "the admin writes inputs, reads results and deletes both",
    },
  ];
  for (const g of bucketGrants) {
    const r = await retry([
      "storage",
      "buckets",
      "add-iam-policy-binding",
      bucketUrl,
      `--member=${g.member}`,
      `--role=${g.role}`,
      ...(g.condition ? [`--condition=${g.condition}`] : []),
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant ${g.role} on ${bucketUrl} (${g.why})`, r);
    done.push(
      `${g.member === member ? "capture job" : "admin"}: ${g.role} on ${bucketUrl}${g.condition ? " (out/ only)" : ""}`,
    );
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
  if (!logs.ok) return fail("grant the capture job roles/logging.logWriter", logs);
  done.push("capture job: roles/logging.logWriter on the project");

  // 5. The admin signs the job's URLs as itself (IAM signBlob).
  const signer = await retry([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    runSa,
    `--member=${runSaMember}`,
    "--role=roles/iam.serviceAccountTokenCreator",
    project,
    "--quiet",
    "--format=none",
  ]);
  if (!signer.ok) return fail("let the admin sign URLs as itself", signer);
  done.push(`admin: roles/iam.serviceAccountTokenCreator on ${runSa} (itself, signed URLs)`);

  // 6. The job: the admin image, its own SA, no secrets, no VPC.
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
    `--args=--bun,${CAPTURE_TASK_SCRIPT}`,
    `--set-env-vars=CAELO_PROVIDER=${provider},CAELO_CAPTURE_BUCKET=${bucket}`,
    "--max-retries=0",
    `--task-timeout=${TASK_TIMEOUT}`,
    "--cpu=1",
    "--memory=2Gi",
    "--quiet",
  ]);
  if (!deploy.ok) return fail(`deploy job ${job}`, deploy);
  done.push(`job ${job} (${target.adminImageRef.split("@")[1]?.slice(0, 19)}...)`);

  // 7. The admin may run it with its order and read its executions.
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
