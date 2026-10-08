// SPDX-License-Identifier: MPL-2.0

/**
 * Set up (and converge) the operator-access sync job on a Google IAP install
 * (`gcp`, `gcp-firebase`). Run by the wizard after migrations and by
 * `cms-provision upgrade`, both as the operator's own gcloud identity.
 *
 * Trust boundary. Who may pass the admin's IAP gate and sign as `caelo-mcp`
 * follows the Caelo user list. The admin does NOT write that: its runtime
 * service account holds no IAM-policy rights. A Cloud Run job with its own
 * service account (admin-core security/operator-access/sync-job.ts) is the
 * only principal that may change those two bindings, and it only ever grants
 * individual `user:` emails read from the database. The admin may only start
 * the job (`roles/run.jobsExecutor` on that job: `run.jobs.run`, not
 * `run.jobs.runWithOverrides`, so it cannot change the job's command, env or
 * arguments — cloud.google.com/run/docs/reference/iam/roles) and read its
 * runs (`roles/run.viewer` on the job). An admin compromise can add users to
 * the database, but cannot make IAP public or grant any other role.
 *
 * What this ensures, every step idempotent:
 *   1. the Cloud Scheduler API;
 *   2. the custom role `caeloOperatorAccess` (get/setIamPolicy only);
 *   3. the job's service account, bound to that role on exactly the admin's
 *      IAP resource and the `caelo-mcp` service account, plus
 *      `cloudsql.instanceUser` + `logging.logWriter`;
 *   4. removal of the admin run SA's operator-access grants an earlier
 *      revision of this feature gave it;
 *   5. Cloud SQL IAM database authentication (flag + the job's IAM database
 *      user, assigned the read-only `operator_access_reader` role that
 *      migration 0239 creates);
 *   6. the job itself (admin image, its own SA, its env), the admin's
 *      execute/view grant on it, and an hourly Cloud Scheduler run.
 *
 * The CLI owns all of this rather than the stacks: the database user can only
 * be given its role once migrations created the role, and a project custom
 * role id is project-global, so a Pulumi-declared copy would collide with
 * the one `upgrade` creates on older installs.
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  gcpNamePrefix,
  mcpIapServiceAccountEmail,
  operatorAccessJobName,
  operatorAccessScheduleName,
  operatorAccessServiceAccountEmail,
  operatorAccessServiceAccountId,
  runServiceAccountEmail,
} from "./gcp-names.js";
import { type IapResource, iapResourceArgs } from "./mcp-iap.js";

type Run = (args: string[]) => Promise<GcloudResult>;

/** A project-level custom role, created by the CLI (never declared in the stacks). */
export interface CustomRoleSpec {
  readonly roleId: string;
  readonly title: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

/** The only IAM-writing rights in this feature, held by the sync job's SA alone. */
export const OPERATOR_ACCESS_ROLE: CustomRoleSpec = {
  roleId: "caeloOperatorAccess",
  title: "Caelo operator access",
  description:
    "Lets the Caelo operator-access sync job set who passes the admin's IAP gate and who may sign as caelo-mcp. Bound only on those two resources, only to the job's service account.",
  permissions: [
    "iap.webServices.getIamPolicy",
    "iap.webServices.setIamPolicy",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.setIamPolicy",
  ],
};

/** Custom role an earlier revision bound to the admin run SA on `gcp`; its binding is removed. */
const LEGACY_LOOKUP_ROLE_ID = "caeloAdminIapLookup";

/** `projects/<project>/roles/<roleId>` — the name IAM bindings reference. */
export function customRoleName(projectId: string, roleId: string): string {
  return `projects/${projectId}/roles/${roleId}`;
}

/**
 * The install's IAP allowlist: who passes IAP regardless of the user list.
 * The wizard passes the same list to the stacks (`iapAllowlist`), and the
 * job keeps these members instead of removing them, so `pulumi up` and the
 * job never fight.
 */
export function installIapAllowlist(ownerEmail: string): string[] {
  return [`user:${ownerEmail.trim().toLowerCase()}`];
}

/** Database role migration 0239 creates for the job. */
export const OPERATOR_ACCESS_DB_ROLE = "operator_access_reader";

/** Where the admin image ships the job's entry point. */
const SYNC_JOB_SCRIPT = "/app/packages/admin-core/src/security/operator-access/sync-job.ts";

/** The `iap_web` path of an IAP resource, as the IAP REST API names it. */
export function iapWebPath(resource: IapResource): string {
  return resource.kind === "cloud-run"
    ? `cloud_run-${resource.region}/services/${resource.service}`
    : `compute/services/${resource.service}`;
}

/** Create the custom role, or bring an existing / soft-deleted one to spec. */
async function ensureCustomRole(
  run: Run,
  projectId: string,
  role: CustomRoleSpec,
): Promise<string | null> {
  const project = `--project=${projectId}`;
  const permissions = `--permissions=${role.permissions.join(",")}`;
  const describe = await run(["iam", "roles", "describe", role.roleId, project, "--format=json"]);
  if (!describe.ok) {
    const create = await run([
      "iam",
      "roles",
      "create",
      role.roleId,
      project,
      `--title=${role.title}`,
      `--description=${role.description}`,
      permissions,
      "--stage=GA",
      "--quiet",
    ]);
    return create.ok ? null : `create role ${role.roleId}: ${create.stderr.trim()}`;
  }
  const current = JSON.parse(describe.stdout) as {
    deleted?: boolean;
    includedPermissions?: string[];
  };
  if (current.deleted) {
    const undelete = await run(["iam", "roles", "undelete", role.roleId, project, "--quiet"]);
    if (!undelete.ok) return `undelete role ${role.roleId}: ${undelete.stderr.trim()}`;
  }
  const have = [...(current.includedPermissions ?? [])].sort().join(",");
  if (have === [...role.permissions].sort().join(",")) return null;
  const update = await run([
    "iam",
    "roles",
    "update",
    role.roleId,
    project,
    permissions,
    "--quiet",
  ]);
  return update.ok ? null : `update role ${role.roleId}: ${update.stderr.trim()}`;
}

/** Whether a gcloud IAM policy (JSON) grants `role` to `member` in any binding. */
function policyHas(policyJson: string, role: string, member: string): boolean {
  const policy = JSON.parse(policyJson.trim() || "{}") as {
    bindings?: { role: string; members?: string[] }[];
  };
  return (policy.bindings ?? []).some((b) => b.role === role && (b.members ?? []).includes(member));
}

/** The flags of a Cloud SQL instance with `cloudsql.iam_authentication` on. */
export function withIamAuthFlag(
  flags: readonly { name: string; value: string }[],
): { name: string; value: string }[] | null {
  if (flags.some((f) => f.name === "cloudsql.iam_authentication" && f.value === "on")) return null;
  return [
    ...flags.filter((f) => f.name !== "cloudsql.iam_authentication"),
    { name: "cloudsql.iam_authentication", value: "on" },
  ];
}

export interface OperatorAccessSyncTarget {
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly ownerEmail: string;
  /** The admin's IAP resource (resolved by the caller). */
  readonly resource: IapResource;
  /** Image the job runs: the admin image being deployed. */
  readonly imageRef: string;
  /** VPC the admin uses to reach Cloud SQL's private IP. */
  readonly network: string;
  readonly subnet: string;
  readonly databaseHost: string;
}

export type OperatorAccessSyncResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/** Ensure the operator-access sync job and everything it needs. Never throws for a gcloud failure. */
export async function ensureOperatorAccessSync(
  target: OperatorAccessSyncTarget,
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<OperatorAccessSyncResult> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const retry = (args: string[]) => runWithRetry(run, sleep, args);
  const { projectId, region, env } = target;
  const project = `--project=${projectId}`;
  const jobSa = operatorAccessServiceAccountEmail(projectId, env);
  const jobMember = `serviceAccount:${jobSa}`;
  const runSaMember = `serviceAccount:${runServiceAccountEmail(projectId, env)}`;
  const mcpSa = mcpIapServiceAccountEmail(projectId);
  const customRole = customRoleName(projectId, OPERATOR_ACCESS_ROLE.roleId);
  const jobName = operatorAccessJobName(env);
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): OperatorAccessSyncResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });

  // 1. Cloud Scheduler API (the hourly self-healing run).
  const api = await run([
    "services",
    "enable",
    "cloudscheduler.googleapis.com",
    project,
    "--quiet",
  ]);
  if (!api.ok) return fail("enable cloudscheduler.googleapis.com", api);
  done.push("Cloud Scheduler API enabled");

  // 2. The custom role.
  const roleError = await ensureCustomRole(run, projectId, OPERATOR_ACCESS_ROLE);
  if (roleError) return { ok: false, done, error: roleError };
  done.push(`custom role ${OPERATOR_ACCESS_ROLE.roleId}`);

  // 3. The job's own service account and its grants.
  const saDescribe = await run([
    "iam",
    "service-accounts",
    "describe",
    jobSa,
    project,
    "--format=value(email)",
  ]);
  if (!saDescribe.ok) {
    const create = await run([
      "iam",
      "service-accounts",
      "create",
      operatorAccessServiceAccountId(env),
      "--display-name=Caelo operator-access sync",
      "--description=The only account that may change who passes the admin's IAP gate; runs the operator-access sync job.",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr))
      return fail(`create ${jobSa}`, create);
  }
  done.push(`service account ${jobSa}`);

  const jobGrants: { what: string; args: string[] }[] = [
    {
      what: `${OPERATOR_ACCESS_ROLE.roleId} on the admin's IAP resource`,
      args: ["iap", "web", "add-iam-policy-binding", ...iapResourceArgs(target.resource)],
    },
    {
      what: `${OPERATOR_ACCESS_ROLE.roleId} on ${mcpSa}`,
      args: ["iam", "service-accounts", "add-iam-policy-binding", mcpSa],
    },
  ];
  for (const g of jobGrants) {
    const r = await retry([
      ...g.args,
      `--member=${jobMember}`,
      `--role=${customRole}`,
      "--condition=None",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the job ${g.what}`, r);
    done.push(`job: ${g.what}`);
  }
  for (const role of ["roles/cloudsql.instanceUser", "roles/logging.logWriter"]) {
    const r = await retry([
      "projects",
      "add-iam-policy-binding",
      projectId,
      `--member=${jobMember}`,
      `--role=${role}`,
      "--condition=None",
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant the job ${role}`, r);
    done.push(`job: ${role} on the project`);
  }

  // 4. The admin's run SA loses every operator-access right an earlier
  //    revision gave it (it may only start the job now).
  const legacy: { what: string; get: string[]; remove: string[]; role: string }[] = [
    {
      what: "the admin's IAP resource",
      get: [
        "iap",
        "web",
        "get-iam-policy",
        ...iapResourceArgs(target.resource),
        project,
        "--format=json",
      ],
      remove: ["iap", "web", "remove-iam-policy-binding", ...iapResourceArgs(target.resource)],
      role: customRole,
    },
    {
      what: mcpSa,
      get: ["iam", "service-accounts", "get-iam-policy", mcpSa, project, "--format=json"],
      remove: ["iam", "service-accounts", "remove-iam-policy-binding", mcpSa],
      role: customRole,
    },
    {
      what: "the project",
      get: ["projects", "get-iam-policy", projectId, "--format=json"],
      remove: ["projects", "remove-iam-policy-binding", projectId],
      role: customRoleName(projectId, LEGACY_LOOKUP_ROLE_ID),
    },
  ];
  for (const l of legacy) {
    const policy = await run(l.get);
    if (!policy.ok) return fail(`read the IAM policy of ${l.what}`, policy);
    if (!policyHas(policy.stdout, l.role, runSaMember)) continue;
    const r = await retry([
      ...l.remove,
      `--member=${runSaMember}`,
      `--role=${l.role}`,
      "--all",
      project,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`remove the admin's ${l.role} on ${l.what}`, r);
    done.push(`admin: removed ${l.role} on ${l.what}`);
  }

  // 5. Cloud SQL IAM database authentication for the job.
  const instances = await run([
    "sql",
    "instances",
    "list",
    project,
    `--filter=name~^${gcpNamePrefix(env)}-pg`,
    "--format=value(name)",
  ]);
  if (!instances.ok) return fail("list Cloud SQL instances", instances);
  const names = instances.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length !== 1) {
    return {
      ok: false,
      done,
      error: `expected exactly one ${gcpNamePrefix(env)}-pg* Cloud SQL instance, found ${names.length} (${names.join(", ")})`,
    };
  }
  const instance = names[0] as string;
  const flagsJson = await run([
    "sql",
    "instances",
    "describe",
    instance,
    project,
    "--format=json(settings.databaseFlags)",
  ]);
  if (!flagsJson.ok) return fail(`read the flags of ${instance}`, flagsJson);
  const flags =
    (
      JSON.parse(flagsJson.stdout) as {
        settings?: { databaseFlags?: { name: string; value: string }[] };
      }
    ).settings?.databaseFlags ?? [];
  const nextFlags = withIamAuthFlag(flags);
  if (nextFlags) {
    // `--database-flags` replaces the whole list, so every existing flag is
    // passed again. cloudsql.iam_authentication needs no restart.
    const patch = await run([
      "sql",
      "instances",
      "patch",
      instance,
      project,
      `--database-flags=${nextFlags.map((f) => `${f.name}=${f.value}`).join(",")}`,
      "--quiet",
    ]);
    if (!patch.ok) return fail(`enable IAM database authentication on ${instance}`, patch);
    done.push(`${instance}: cloudsql.iam_authentication=on`);
  }
  const dbUser = jobSa.replace(/\.gserviceaccount\.com$/, "");
  const users = await run([
    "sql",
    "users",
    "list",
    `--instance=${instance}`,
    project,
    "--format=value(name)",
  ]);
  if (!users.ok) return fail(`list database users of ${instance}`, users);
  if (
    !users.stdout
      .split("\n")
      .map((s) => s.trim())
      .includes(dbUser)
  ) {
    const create = await run([
      "sql",
      "users",
      "create",
      dbUser,
      `--instance=${instance}`,
      "--type=cloud_iam_service_account",
      project,
      "--quiet",
    ]);
    if (!create.ok) return fail(`create database user ${dbUser}`, create);
  }
  const assign = await run([
    "sql",
    "users",
    "assign-roles",
    dbUser,
    `--instance=${instance}`,
    "--type=cloud_iam_service_account",
    `--database-roles=${OPERATOR_ACCESS_DB_ROLE}`,
    project,
    "--quiet",
  ]);
  if (!assign.ok)
    return fail(`give ${dbUser} the ${OPERATOR_ACCESS_DB_ROLE} database role`, assign);
  done.push(`database user ${dbUser} (${OPERATOR_ACCESS_DB_ROLE})`);

  // 6. The job: the admin image with another entry point, the job's own SA,
  //    and its whole input as env the admin cannot override.
  const envVars = [
    `CAELO_OPERATOR_ACCESS_IAP_WEB=${iapWebPath(target.resource)}`,
    `CAELO_MCP_IAP_SERVICE_ACCOUNT=${mcpSa}`,
    `CAELO_OPERATOR_ACCESS_STATIC_MEMBERS=${installIapAllowlist(target.ownerEmail).join(",")}`,
    `CAELO_OPERATOR_ACCESS_DB_HOST=${target.databaseHost}`,
  ];
  const deploy = await run([
    "run",
    "jobs",
    "deploy",
    jobName,
    `--image=${target.imageRef}`,
    `--region=${region}`,
    project,
    `--service-account=${jobSa}`,
    `--network=${target.network}`,
    `--subnet=${target.subnet}`,
    "--vpc-egress=private-ranges-only",
    "--command=bun",
    `--args=--bun,${SYNC_JOB_SCRIPT}`,
    // `^|^` switches gcloud's list delimiter: the static members contain commas.
    `--set-env-vars=^|^${envVars.join("|")}`,
    "--max-retries=1",
    "--task-timeout=5m",
    "--quiet",
  ]);
  if (!deploy.ok) return fail(`deploy job ${jobName}`, deploy);
  done.push(`job ${jobName}`);

  const jobIam: { member: string; role: string; why: string }[] = [
    {
      member: runSaMember,
      role: "roles/run.jobsExecutor",
      why: "the admin starts the job (no overrides)",
    },
    { member: runSaMember, role: "roles/run.viewer", why: "the admin reads the job's runs" },
    {
      member: jobMember,
      role: "roles/run.jobsExecutor",
      why: "the hourly schedule starts the job as its own SA",
    },
  ];
  for (const g of jobIam) {
    const r = await retry([
      "run",
      "jobs",
      "add-iam-policy-binding",
      jobName,
      `--region=${region}`,
      project,
      `--member=${g.member}`,
      `--role=${g.role}`,
      "--quiet",
      "--format=none",
    ]);
    if (!r.ok) return fail(`grant ${g.role} on ${jobName} (${g.why})`, r);
    done.push(`${g.member}: ${g.role} on ${jobName}`);
  }

  const schedule = operatorAccessScheduleName(env);
  const scheduleArgs = [
    schedule,
    `--location=${region}`,
    project,
    "--schedule=17 * * * *",
    "--time-zone=Etc/UTC",
    `--uri=https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}:run`,
    "--http-method=POST",
    `--oauth-service-account-email=${jobSa}`,
    "--quiet",
  ];
  const existing = await run([
    "scheduler",
    "jobs",
    "describe",
    schedule,
    `--location=${region}`,
    project,
    "--format=value(name)",
  ]);
  const sched = await retry([
    "scheduler",
    "jobs",
    existing.ok ? "update" : "create",
    "http",
    ...scheduleArgs,
  ]);
  if (!sched.ok) return fail(`schedule ${schedule}`, sched);
  done.push(`hourly schedule ${schedule}`);

  return { ok: true, done };
}

/**
 * Everything {@link ensureOperatorAccessSync} needs, read from the deployed
 * admin service: its network, the database host, and its IAP resource (the
 * service itself on gcp-firebase, the LB backend service on gcp). `imageRef`
 * overrides the image the job runs (upgrade passes the release it rolls to).
 */
export async function resolveOperatorAccessTarget(
  opts: {
    readonly provider: "gcp" | "gcp-firebase";
    readonly projectId: string;
    readonly region: string;
    readonly env: string;
    readonly ownerEmail: string;
    readonly imageRef?: string;
  },
  deps: { run?: GcloudRunner } = {},
): Promise<{ ok: true; target: OperatorAccessSyncTarget } | { ok: false; error: string }> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${opts.projectId}`;
  const prefix = `${gcpNamePrefix(opts.env)}-admin`;
  const list = await run([
    "run",
    "services",
    "list",
    `--region=${opts.region}`,
    project,
    `--filter=metadata.name~^${prefix}`,
    "--format=value(metadata.name)",
  ]);
  if (!list.ok) return { ok: false, error: `list Cloud Run services: ${list.stderr.trim()}` };
  const services = lines(list.stdout);
  if (services.length !== 1) {
    return {
      ok: false,
      error: `expected exactly one ${prefix}* Cloud Run service, found ${services.length} (${services.join(", ")})`,
    };
  }
  const adminService = services[0] as string;
  const describe = await run([
    "run",
    "services",
    "describe",
    adminService,
    `--region=${opts.region}`,
    project,
    "--format=json",
  ]);
  if (!describe.ok) {
    return { ok: false, error: `describe ${adminService}: ${describe.stderr.trim()}` };
  }
  const { parseAdminConfig } = await import("./migration-runner.js");
  const admin = parseAdminConfig(describe.stdout);
  if (!admin) {
    return {
      ok: false,
      error: `${adminService} lacks an image, database host or VPC network the job can reuse`,
    };
  }

  let resource: IapResource;
  if (opts.provider === "gcp-firebase") {
    resource = { kind: "cloud-run", service: adminService, region: opts.region };
  } else {
    const backends = await run([
      "compute",
      "backend-services",
      "list",
      "--global",
      project,
      `--filter=name~^${prefix}-backend AND iap.enabled=true`,
      "--format=value(name)",
    ]);
    if (!backends.ok) {
      return { ok: false, error: `list backend services: ${backends.stderr.trim()}` };
    }
    const names = lines(backends.stdout);
    if (names.length !== 1) {
      return {
        ok: false,
        error: `expected exactly one IAP-enabled ${prefix}-backend* backend service, found ${names.length} (${names.join(", ")})`,
      };
    }
    resource = { kind: "backend-services", service: names[0] as string };
  }
  const short = (ref: string) => ref.split("/").pop() ?? ref;
  return {
    ok: true,
    target: {
      projectId: opts.projectId,
      region: opts.region,
      env: opts.env,
      ownerEmail: opts.ownerEmail,
      resource,
      imageRef: opts.imageRef ?? admin.imageRef,
      network: short(admin.networkRef),
      subnet: short(admin.subnetRef),
      databaseHost: admin.databaseHost,
    },
  };
}

function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
