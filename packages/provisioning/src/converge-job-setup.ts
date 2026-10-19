// SPDX-License-Identifier: MPL-2.0

/**
 * Set up (and converge) the converge job on a Google Cloud install (`gcp`,
 * `gcp-firebase`), #819. Run by the wizard (laptop, Cloud Shell or the
 * install job) after migrations and by every converge — `cms-provision
 * upgrade` and the converge job itself — so the job always runs the ops
 * image of the release the install last converged to.
 *
 * What it is. A release that raises the infrastructure contract
 * (infra-contract.ts) needs rights the upgrader job deliberately lacks:
 * IAM bindings, service accounts, secrets. Until #819 that meant the Owner
 * ran the upgrade from a terminal with their own Google account. The
 * converge job runs the very same upgrade (upgrade/upgrade.ts: backup,
 * converge, roll, health check, rollback, records) from inside the
 * install's project, as the install's existing `caelo-provisioner` service
 * account — the account the install job already runs `pulumi up` as and
 * that already holds every right a converge needs (gcloud.ts
 * PROVISIONER_ROLES). No new privileged identity is created.
 *
 * Trust boundary — the same shape as the upgrader job (upgrader-setup.ts)
 * and the operator-access job. The admin's runtime service account gets
 * exactly two roles, both on this one job:
 *
 *   - `roles/run.jobsExecutor`: `run.jobs.run` WITHOUT
 *     `run.jobs.runWithOverrides` — it may start the job, never change its
 *     image, command, args or env (cloud.google.com/run/docs/reference/iam/roles);
 *   - `roles/run.viewer`: read its executions (the page's "Continue" for a
 *     run that died, and the dead-run check).
 *
 * The job takes no input but the database: its only input is the request
 * row's target version. It fetches that release's manifest from the FIXED
 * registry, verifies its signature with cosign, refuses a downgrade or a
 * release below `minFromVersion`, and then runs only that release's signed
 * ops image, pinned by the digest the manifest names (converge-job.ts). So a
 * compromised admin can at most make the install converge to a newer
 * signed Caelo release — what the Owner's click does anyway.
 *
 * What the provisioner gets here, on top of what it holds since install:
 *
 *   - {@link INSTALL_JOB_ROLES} (the operator-access step of a converge
 *     creates a custom role and a Cloud Scheduler job, and the job's lines
 *     must reach Cloud Logging) — what an install-job install already
 *     grants; not an escalation, the provisioner holds projectIamAdmin;
 *   - a Cloud SQL IAM database login that is a member of `platform_updater`
 *     only (migration 0267): it reads its request and writes the timeline,
 *     nothing else in the database.
 */

import { ensureCloudSqlIamUser } from "./cloudsql-iam-user.js";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { convergeJobName, runServiceAccountEmail } from "./gcp-names.js";
import { INSTALL_JOB_ROLES } from "./install-job.js";
import { provisionerServiceAccountEmail } from "./provisioner-identity.js";
import { opsBucketName } from "./state-backend.js";
import { UPGRADER_DB_ROLE } from "./upgrader-setup.js";

/**
 * The job's task timeout in minutes, and the lease on the state lock it
 * holds (state-lock-lease.ts): after it, Cloud Run has killed the run and a
 * new execution resumes from the checkpoint. A converge plus a roll takes
 * 10–20 minutes; the live 0.10.51 run needed 7 before its roll.
 */
export const CONVERGE_TASK_TIMEOUT_MINUTES = 60;

/**
 * Exactly what the admin's runtime service account may do on the converge
 * job — start it (no overrides) and read its runs. The setup grants these
 * two and nothing else; the tests assert it.
 */
export const CONVERGE_ADMIN_ROLES = ["roles/run.jobsExecutor", "roles/run.viewer"] as const;

/** The `caelo-ops` subcommand the job runs (Dockerfile.ops drops any further argument). */
export const CONVERGE_JOB_COMMAND = "converge-job";

/** Resources: the converge runs gcloud + Pulumi's Node language host for the stack pin. */
const JOB_CPU = "2";
const JOB_MEMORY = "4Gi";

export interface ConvergeSetupTarget {
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** The caelo-ops image to run, digest-pinned (`…/ops@sha256:…`). */
  readonly opsImageRef: string;
  /** VPC the admin uses to reach Cloud SQL's private IP (the job's queue does too). */
  readonly network: string;
  readonly subnet: string;
}

export type ConvergeSetupResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/**
 * The `gcloud run jobs deploy` argv of the converge job: the ops image by
 * digest, the provisioner as its identity, no env and no secrets, the one
 * fixed subcommand. Exported for the tests that pin the boundary.
 */
export function convergeJobDeployArgs(target: ConvergeSetupTarget): string[] {
  return [
    "run",
    "jobs",
    "deploy",
    convergeJobName(target.env),
    `--image=${target.opsImageRef}`,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    `--service-account=${provisionerServiceAccountEmail(target.projectId)}`,
    `--network=${target.network}`,
    `--subnet=${target.subnet}`,
    "--vpc-egress=private-ranges-only",
    "--command=caelo-ops",
    `--args=${CONVERGE_JOB_COMMAND}`,
    "--tasks=1",
    // A retry would start a second converge inside the same execution; a
    // killed run is resumed by starting the job again (checkpointed).
    "--max-retries=0",
    `--task-timeout=${CONVERGE_TASK_TIMEOUT_MINUTES}m`,
    `--cpu=${JOB_CPU}`,
    `--memory=${JOB_MEMORY}`,
    "--labels=caelo-role=converge",
    "--quiet",
  ];
}

/** Ensure the converge job and everything it needs. Never throws for a gcloud failure. */
export async function ensureConvergeJob(
  target: ConvergeSetupTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ConvergeSetupResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env } = target;
  const project = `--project=${projectId}`;
  const provisioner = provisionerServiceAccountEmail(projectId);
  const member = `serviceAccount:${provisioner}`;
  const adminMember = `serviceAccount:${runServiceAccountEmail(projectId, env)}`;
  const job = convergeJobName(env);
  const bucket = opsBucketName(projectId);
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): ConvergeSetupResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  if (!/@sha256:[0-9a-f]{64}$/.test(target.opsImageRef)) {
    return {
      ok: false,
      done,
      error: `the converge job's image must be pinned by digest, got ${target.opsImageRef}`,
    };
  }

  // The job attaches the install from its ops bucket and keeps its
  // checkpoints there; an install whose state is on a laptop has neither.
  const bucketCheck = await run([
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    project,
    "--format=value(name)",
  ]);
  if (!bucketCheck.ok) {
    return {
      ok: false,
      done,
      error: `the ops bucket gs://${bucket} is not there (${bucketCheck.stderr.trim()}). Move the install's state into its own project first: cms-provision state migrate`,
    };
  }

  // The job's identity is the install's provisioner — never created here:
  // an install without one (installed before it existed) keeps converging
  // from a terminal.
  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    provisioner,
    project,
    "--format=value(email)",
  ]);
  if (!describe.ok) {
    return {
      ok: false,
      done,
      error: `this install has no ${provisioner} service account (${describe.stderr.trim()}), which the converge job runs as. Updates that change the cloud setup keep running from a terminal (Settings → Updates shows the command).`,
    };
  }

  // 1. What a converge run as the provisioner needs beyond the install roles.
  for (const role of INSTALL_JOB_ROLES) {
    const r = await retry([
      "projects",
      "add-iam-policy-binding",
      projectId,
      `--member=${member}`,
      `--role=${role}`,
      "--condition=None",
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the provisioner ${role}`, r);
    done.push(`provisioner: ${role} on the project`);
  }

  // 2. Its database login: the request row and the timeline, nothing else.
  const sqlUser = await ensureCloudSqlIamUser(run, {
    projectId,
    env,
    serviceAccountEmail: provisioner,
    databaseRole: UPGRADER_DB_ROLE,
  });
  done.push(...sqlUser.done);
  if (!sqlUser.ok) return { ok: false, done, error: sqlUser.error };

  // 3. The job itself.
  const deploy = await run(convergeJobDeployArgs(target));
  if (!deploy.ok) return fail(`deploy job ${job}`, deploy);
  done.push(`job ${job} (${target.opsImageRef.split("@")[1]?.slice(0, 19)}...)`);

  // 4. The admin may start it (no overrides) and read its runs — nothing else.
  for (const role of CONVERGE_ADMIN_ROLES) {
    const r = await retry([
      "run",
      "jobs",
      "add-iam-policy-binding",
      job,
      `--region=${region}`,
      project,
      `--member=${adminMember}`,
      `--role=${role}`,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the admin ${role} on ${job}`, r);
    done.push(`admin: ${role} on ${job}`);
  }
  return { ok: true, done };
}
