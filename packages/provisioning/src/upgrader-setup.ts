// SPDX-License-Identifier: MPL-2.0

/**
 * Set up (and converge) the upgrader job on a Google Cloud install (`gcp`,
 * `gcp-firebase`), epic #696 Phase 2. Run by the wizard after migrations and
 * by `cms-provision upgrade`'s converge, both as the operator's own gcloud
 * identity — never by the admin, never by the job itself.
 *
 * Trust boundary (same shape as operator-access.ts). The admin may only
 * START the job: `roles/run.jobsExecutor` on that one job — `run.jobs.run`
 * without `run.jobs.runWithOverrides` (cloud.google.com/run/docs/reference/
 * iam/roles) — plus `roles/run.viewer` on it to read its runs. It cannot
 * change the job's image, command, args or env, and it holds no other
 * right the job has. What the job installs comes from the request row
 * (just a version) and the signed release manifest (upgrader-job.ts).
 *
 * The job's own service account, `caelo-<env>-upgrader`, may do exactly
 * what an app-roll needs (upgrade/app-roll.ts):
 *
 *   - `roles/run.developer` on the project: deploy admin/gateway revisions,
 *     move traffic, recreate the migration job, update its own job image.
 *     It includes no `*.setIamPolicy`.
 *   - `roles/iam.serviceAccountUser` on exactly the admin's and the
 *     gateway's runtime service accounts (a revision runs as them), on
 *     itself (its own job) and on the quality-audit job's account (the
 *     app-roll moves that job's image, #875) — not on the project.
 *   - the custom role `caeloUpgraderSqlBackup`: create/read Cloud SQL
 *     backups and read the instance — no restore, no instance changes.
 *   - `roles/cloudsql.instanceUser` + a Cloud SQL IAM database user that
 *     is a member of `platform_updater` (migration 0267) only.
 *   - `roles/iam.serviceAccountTokenCreator` on caelo-mcp only: the deep
 *     health check signs its IAP credential as that account
 *     (upgrade/health.ts). The operator-access sync job keeps it there.
 *   - `roles/storage.objectUser` on the ops bucket, conditioned to the
 *     `install/` prefix (install.json, the state lock) — not the Pulumi state.
 *   - the custom role `caeloUpgraderOpsList` (`storage.objects.list` only)
 *     on the ops bucket, unconditioned: `gcloud storage cp` lists the
 *     destination prefix and reads the bucket's storage layout before every
 *     upload, and GCS checks both against the bucket, never an object path,
 *     so no `install/` condition can admit them. It reveals object names,
 *     not contents.
 *   - `roles/logging.logWriter`.
 *
 * It gets no `*.setIamPolicy`, no service-account admin, no secret
 * creation, no compute and no resourcemanager rights: whatever needs them
 * is a converge, which only the operator runs ("Run in Cloud Shell").
 * {@link UPGRADER_FORBIDDEN_ROLES} names that line; the tests assert no
 * grant crosses it.
 *
 * Direct VPC egress (#818): the migration job and both services run with
 * `--network/--subnet`. Google documents the compute permissions that needs
 * (`compute.subnetworks.use`, `compute.addresses.createInternal`, …) on the
 * Cloud Run service agent, which `roles/run.serviceAgent` already gives it
 * (cloud.google.com/run/docs/configuring/vpc-direct-vpc), not on the
 * principal that deploys. So the upgrader gets no compute role; the
 * real-GCP upgrader smoke test (.github/workflows/upgrader-smoke.yml) proves
 * it on every release candidate. Every permission the job needs is checked
 * by the job itself before it changes anything (upgrader-iam-preflight.ts);
 * a grant added or removed here must keep that list in step.
 */

import { ensureCloudSqlIamUser } from "./cloudsql-iam-user.js";
import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  auditServiceAccountEmail,
  gatewayServiceAccountEmail,
  mcpIapServiceAccountEmail,
  runServiceAccountEmail,
  upgraderJobName,
  upgraderServiceAccountEmail,
  upgraderServiceAccountId,
} from "./gcp-names.js";
import { readAdminConfig } from "./migration-runner.js";
import { type CustomRoleSpec, customRoleName, ensureCustomRole } from "./operator-access.js";
import { OPS_INSTALL_PREFIX, opsBucketName } from "./state-backend.js";

/** Cloud SQL backups for the pre-upgrade backup — nothing else on the instance. */
export const UPGRADER_SQL_BACKUP_ROLE: CustomRoleSpec = {
  roleId: "caeloUpgraderSqlBackup",
  title: "Caelo upgrader: Cloud SQL backups",
  description:
    "Lets the Caelo upgrader job take and read on-demand Cloud SQL backups before an update. No restore, no instance changes.",
  permissions: [
    "cloudsql.backupRuns.create",
    "cloudsql.backupRuns.get",
    "cloudsql.backupRuns.list",
    "cloudsql.instances.get",
    "cloudsql.instances.list",
  ],
};

/**
 * Listing the ops bucket, which every `gcloud storage cp` into it needs (see
 * the file header). Names only — reads and writes stay on `install/`.
 */
export const UPGRADER_OPS_LIST_ROLE: CustomRoleSpec = {
  roleId: "caeloUpgraderOpsList",
  title: "Caelo upgrader: list the ops bucket",
  description:
    "Lets the Caelo upgrader job list object names in the install's ops bucket (gcloud storage cp needs it). Names only; object reads/writes stay limited to install/.",
  permissions: ["storage.objects.list"],
};

/** Project-level roles of the upgrader's service account. */
export const UPGRADER_PROJECT_ROLES = [
  "roles/run.developer",
  "roles/cloudsql.instanceUser",
  "roles/logging.logWriter",
] as const;

/**
 * Roles the upgrader must never hold anywhere — they would let it change
 * IAM, manage service accounts or secrets, or touch compute/projects.
 * Prefix matches (`roles/compute.` = every compute role).
 */
export const UPGRADER_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/run.admin",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.serviceAccountKeyAdmin",
  "roles/iam.securityAdmin",
  "roles/iam.roleAdmin",
  "roles/resourcemanager.",
  "roles/secretmanager.admin",
  "roles/secretmanager.secretVersionAdder",
  "roles/compute.",
  "roles/cloudsql.admin",
  "roles/cloudsql.editor",
  "roles/storage.admin",
  "roles/storage.objectAdmin",
] as const;

/** Database role migration 0267 creates for the job. */
export const UPGRADER_DB_ROLE = "platform_updater";

/**
 * The job's task timeout in minutes: enough for a backup + roll; the job
 * ends within it. It is also the lease on the state lock the job takes
 * (#815, state-lock-lease.ts): after it, Cloud Run has killed the run.
 */
export const UPGRADER_TASK_TIMEOUT_MINUTES = 60;

const JOB_TASK_TIMEOUT = `${UPGRADER_TASK_TIMEOUT_MINUTES}m`;

export interface UpgraderSetupTarget {
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  /** The caelo-ops image to run, digest-pinned (`…/ops@sha256:…`). */
  readonly opsImageRef: string;
  /** VPC the admin uses to reach Cloud SQL's private IP. */
  readonly network: string;
  readonly subnet: string;
}

export type UpgraderSetupResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/** The ops bucket condition: install.json and progress.json, not the Pulumi state. */
export function installStateCondition(bucket: string): string {
  return `expression=resource.name.startsWith("projects/_/buckets/${bucket}/objects/${OPS_INSTALL_PREFIX}/"),title=caelo-upgrader-install-state,description=Only the install metadata under ${OPS_INSTALL_PREFIX}/`;
}

/** Ensure the upgrader job and everything it needs. Never throws for a gcloud failure. */
export async function ensureUpgraderJob(
  target: UpgraderSetupTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<UpgraderSetupResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env } = target;
  const project = `--project=${projectId}`;
  const sa = upgraderServiceAccountEmail(projectId, env);
  const member = `serviceAccount:${sa}`;
  const runSaMember = `serviceAccount:${runServiceAccountEmail(projectId, env)}`;
  const job = upgraderJobName(env);
  const bucket = opsBucketName(projectId);
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): UpgraderSetupResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  if (!/@sha256:[0-9a-f]{64}$/.test(target.opsImageRef)) {
    return {
      ok: false,
      done,
      error: `the upgrader image must be pinned by digest, got ${target.opsImageRef}`,
    };
  }

  // The job keeps install.json in the install's own ops bucket; an install
  // whose state still lives on the operator's machine has none.
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

  // 1. The backup and ops-bucket-list roles.
  for (const role of [UPGRADER_SQL_BACKUP_ROLE, UPGRADER_OPS_LIST_ROLE]) {
    const roleError = await ensureCustomRole(run, projectId, role);
    if (roleError) return { ok: false, done, error: roleError };
    done.push(`custom role ${role.roleId}`);
  }

  // 2. The job's own service account.
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
      upgraderServiceAccountId(env),
      "--display-name=Caelo upgrader",
      "--description=Installs signed Caelo releases started from the admin; may roll the services and back up Cloud SQL, never change IAM.",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) return fail(`create ${sa}`, create);
  }
  done.push(`service account ${sa}`);

  // 3. Project-level roles.
  for (const role of [
    ...UPGRADER_PROJECT_ROLES,
    customRoleName(projectId, UPGRADER_SQL_BACKUP_ROLE.roleId),
  ]) {
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
    if (!r.ok) return fail(`grant the upgrader ${role}`, r);
    done.push(`upgrader: ${role} on the project`);
  }

  // 4. Resource-level grants on single service accounts.
  const onAccounts: { account: string; role: string; why: string }[] = [
    {
      account: runServiceAccountEmail(projectId, env),
      role: "roles/iam.serviceAccountUser",
      why: "admin revisions + the migration job run as it",
    },
    {
      account: gatewayServiceAccountEmail(projectId, env),
      role: "roles/iam.serviceAccountUser",
      why: "gateway revisions run as it",
    },
    { account: sa, role: "roles/iam.serviceAccountUser", why: "the job updates its own image" },
    {
      account: auditServiceAccountEmail(projectId, env),
      role: "roles/iam.serviceAccountUser",
      why: "the app-roll moves the quality-audit job, which runs as it, onto the new image",
    },
    {
      account: mcpIapServiceAccountEmail(projectId),
      role: "roles/iam.serviceAccountTokenCreator",
      why: "the health check signs its IAP credential as caelo-mcp",
    },
  ];
  for (const g of onAccounts) {
    const r = await retry([
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      g.account,
      `--member=${member}`,
      `--role=${g.role}`,
      "--condition=None",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the upgrader ${g.role} on ${g.account} (${g.why})`, r);
    done.push(`upgrader: ${g.role} on ${g.account}`);
  }

  // 5. install.json in the ops bucket — and nothing else there.
  const bucketGrant = await retry([
    "storage",
    "buckets",
    "add-iam-policy-binding",
    `gs://${bucket}`,
    `--member=${member}`,
    "--role=roles/storage.objectUser",
    `--condition=${installStateCondition(bucket)}`,
    project,
    "--quiet",
    "--format=none",
  ]);
  if (!bucketGrant.ok)
    return fail(`grant the upgrader install.json in gs://${bucket}`, bucketGrant);
  done.push(`upgrader: roles/storage.objectUser on gs://${bucket}/${OPS_INSTALL_PREFIX}/`);

  const listRole = customRoleName(projectId, UPGRADER_OPS_LIST_ROLE.roleId);
  const listGrant = await retry([
    "storage",
    "buckets",
    "add-iam-policy-binding",
    `gs://${bucket}`,
    `--member=${member}`,
    `--role=${listRole}`,
    "--condition=None",
    project,
    "--quiet",
    "--format=none",
  ]);
  if (!listGrant.ok) return fail(`grant the upgrader object listing on gs://${bucket}`, listGrant);
  done.push(`upgrader: ${listRole} on gs://${bucket}`);

  // 6. Its database login (migration 0267's platform_updater role).
  const sqlUser = await ensureCloudSqlIamUser(run, {
    projectId,
    env,
    serviceAccountEmail: sa,
    databaseRole: UPGRADER_DB_ROLE,
  });
  done.push(...sqlUser.done);
  if (!sqlUser.ok) return { ok: false, done, error: sqlUser.error };

  // 7. The job: the ops image, its own SA, no env, no input but the database.
  const deploy = await run([
    "run",
    "jobs",
    "deploy",
    job,
    `--image=${target.opsImageRef}`,
    `--region=${region}`,
    project,
    `--service-account=${sa}`,
    `--network=${target.network}`,
    `--subnet=${target.subnet}`,
    "--vpc-egress=private-ranges-only",
    "--command=caelo-ops",
    "--args=upgrader",
    "--max-retries=0",
    `--task-timeout=${JOB_TASK_TIMEOUT}`,
    "--memory=1Gi",
    "--cpu=1",
    "--quiet",
  ]);
  if (!deploy.ok) return fail(`deploy job ${job}`, deploy);
  done.push(`job ${job} (${target.opsImageRef.split("@")[1]?.slice(0, 19)}...)`);

  // 8. The admin may start it (no overrides) and read its runs — nothing else.
  for (const role of ["roles/run.jobsExecutor", "roles/run.viewer"]) {
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
 * {@link ensureUpgraderJob}'s target, with the VPC read from the deployed
 * admin service (the job reaches Cloud SQL's private IP the same way).
 */
export async function resolveUpgraderTarget(
  opts: {
    readonly projectId: string;
    readonly region: string;
    readonly env: string;
    readonly opsImageRef: string;
  },
  deps: { run?: GcloudRunner } = {},
): Promise<{ ok: true; target: UpgraderSetupTarget } | { ok: false; error: string }> {
  const cfg = await readAdminConfig(opts, deps.run ?? defaultGcloud);
  if (!cfg) {
    return { ok: false, error: "could not read the admin service's VPC (is the admin deployed?)" };
  }
  const short = (ref: string) => ref.split("/").pop() ?? ref;
  return {
    ok: true,
    target: { ...opts, network: short(cfg.networkRef), subnet: short(cfg.subnetRef) },
  };
}
