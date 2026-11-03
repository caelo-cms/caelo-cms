// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's IAM self-check (#884): before the job takes the state
 * lock, hands over or backs anything up, it asks Google Cloud whether its
 * identity — the install's `caelo-provisioner` — holds what the converge
 * relies on, and stops with every missing permission named when it does
 * not. Same mechanism and types as the upgrader's (upgrader-iam-preflight.ts,
 * #818); only the list and the voice differ.
 *
 * What is checked is what converge-job-setup.ts grants or relies on, derived
 * from the same constants so the two cannot drift:
 *
 *   - every role of {@link INSTALL_JOB_ROLES} that `ensureConvergeJob`
 *     grants the provisioner, each by the permissions the converge uses from
 *     it ({@link INSTALL_ROLE_USES} is keyed by the role, so a new role
 *     without a check does not compile);
 *   - the ops bucket: install.json + the state lock under `install/`, the
 *     checkpoint under `converge/`. The provisioner holds them through the
 *     project's roles/storage.admin, which carries no IAM condition, so the
 *     bucket's own testIamPermissions answers for every prefix (unlike the
 *     upgrader's `install/`-conditioned grant, which has to be probed);
 *   - the converge job itself: stage 1 points it at the target's ops image
 *     and starts a new execution, and the job keeps running as the
 *     provisioner (actAs on its own account);
 *   - the Cloud SQL IAM login `ensureConvergeJob` creates (member of
 *     {@link UPGRADER_DB_ROLE}): the request row and the timeline.
 *
 * Self-grant (maintainer decision 2026-11-03). A release may add a role to
 * {@link INSTALL_JOB_ROLES} (0.11.11 added roles/workflows.editor for the
 * scheduler tick, #1140); an install set up before it lacks that role until
 * a converge's `ensureConvergeJob` grants it, and the converge job used to
 * stop here and send the Owner to Cloud Shell for exactly that grant. Now a
 * missing role of {@link CONVERGE_SELF_GRANTABLE_ROLES} — this release's own
 * compiled-in list, nothing a request, a record or the environment names —
 * is not a reason to stop: stage 1 leaves it to stage 2, and stage 2 (the
 * target release's verified ops image, under the state lock) grants it to
 * the provisioner at project level, records each grant on the timeline and
 * asks IAM again (converge-job.ts). Not an escalation: the provisioner holds
 * roles/resourcemanager.projectIamAdmin since install, so it could grant
 * itself any role already; the allowlist only narrows what the job does
 * with that. {@link SELF_GRANT_FORBIDDEN_ROLES} pins that the list never
 * names an ownership or IAM-policy role, and the upgrader job — which holds
 * no IAM rights at all — has no grant step.
 *
 * Not checked: the permissions `pulumi up` needs for the stack. They are the
 * provisioner's PROVISIONER_ROLE_LIST (gcloud.ts), granted at install by the
 * Owner's own account; a converge cannot repair them and Pulumi names what
 * it lacks precisely.
 */

import { CONVERGE_STATE_PREFIX } from "./converge-checkpoint.js";
import { convergeJobName } from "./gcp-names.js";
import { INSTALL_JOB_ROLES, type InstallJobRole } from "./install-job.js";
import { provisionerServiceAccountEmail } from "./provisioner-identity.js";
import { OPS_INSTALL_PREFIX, opsBucketName } from "./state-backend.js";
import type { AccessCheck, MissingAccess, PreflightVoice } from "./upgrader-iam-preflight.js";
import { UPGRADER_DB_ROLE } from "./upgrader-setup.js";

/**
 * What a converge does with each role `ensureConvergeJob` grants the
 * provisioner on top of its install roles, and the permissions of that role
 * it uses (operator-access.ts creates the custom role and the scheduler
 * job; the job's lines go to Cloud Logging).
 */
export const INSTALL_ROLE_USES: Record<
  InstallJobRole,
  { readonly need: string; readonly permissions: readonly string[] }
> = {
  "roles/iam.roleAdmin": {
    need: "create and update the custom role that decides who may open the admin",
    permissions: ["iam.roles.create", "iam.roles.get", "iam.roles.update"],
  },
  "roles/cloudscheduler.admin": {
    need: "create and update the schedule that keeps the admin's access list in sync",
    permissions: [
      "cloudscheduler.jobs.create",
      "cloudscheduler.jobs.get",
      "cloudscheduler.jobs.update",
    ],
  },
  "roles/workflows.editor": {
    need: "deploy and update the workflow the scheduler tick runs (#1140)",
    permissions: [
      "workflows.workflows.create",
      "workflows.workflows.get",
      "workflows.workflows.update",
    ],
  },
  "roles/logging.logWriter": {
    need: "write the update's progress to Cloud Logging",
    permissions: ["logging.logEntries.create"],
  },
};

/** The converge job's voice: the setup is re-converged by a terminal upgrade. */
export const CONVERGE_PREFLIGHT_VOICE: PreflightVoice = {
  subject: "the converge job",
  repair:
    "Run the update once from Cloud Shell or the computer you installed from (Settings → Updates shows the command); it repairs the converge job's access.",
};

/**
 * The roles the converge job may grant its own account when the self-check
 * finds them missing: exactly the roles `ensureConvergeJob` grants it, as
 * compiled into this release (see the file comment).
 */
export const CONVERGE_SELF_GRANTABLE_ROLES: readonly InstallJobRole[] = INSTALL_JOB_ROLES;

/**
 * Roles the converge job must never grant itself, whatever a release's list
 * says — ownership and IAM-policy roles (prefix matches). The tests assert
 * {@link CONVERGE_SELF_GRANTABLE_ROLES} names none of them, and the grant
 * step refuses them again at run time.
 */
export const SELF_GRANT_FORBIDDEN_ROLES = [
  "roles/owner",
  "roles/editor",
  "roles/resourcemanager.",
  "roles/iam.securityAdmin",
  "roles/iam.organizationRoleAdmin",
  "roles/iam.serviceAccountKeyAdmin",
  "roles/iam.workloadIdentityPoolAdmin",
  "roles/orgpolicy.",
  "roles/billing.",
] as const;

/** Whether the converge job may grant `role` to its own account (see the file comment). */
export function isSelfGrantableRole(role: string): role is InstallJobRole {
  return (
    (CONVERGE_SELF_GRANTABLE_ROLES as readonly string[]).includes(role) &&
    !SELF_GRANT_FORBIDDEN_ROLES.some((f) => role === f || (f.endsWith(".") && role.startsWith(f)))
  );
}

/** A converge self-check; `role` marks a check that granting that role repairs. */
export interface ConvergeAccessCheck extends AccessCheck {
  readonly role?: InstallJobRole;
}

/** What the converge job does about the self-check's missing permissions. */
export interface SelfGrantPlan {
  /** Allowlisted roles to grant the provisioner, in list order. */
  readonly grant: readonly InstallJobRole[];
  /** What no grant of the job repairs: the run stops on any of these. */
  readonly blocking: readonly MissingAccess<ConvergeAccessCheck>[];
}

/**
 * Split the self-check's missing permissions into roles the job grants
 * itself and the rest. A check counts as repairable only when its whole
 * shortfall is permissions of an allowlisted role it is marked with.
 */
export function selfGrantPlan(
  missing: readonly MissingAccess<ConvergeAccessCheck>[],
): SelfGrantPlan {
  const grant: InstallJobRole[] = [];
  const blocking: MissingAccess<ConvergeAccessCheck>[] = [];
  for (const m of missing) {
    const role = m.check.role;
    if (role && isSelfGrantableRole(role) && !(m.unchecked && m.unchecked.length > 0)) {
      if (!grant.includes(role)) grant.push(role);
    } else {
      blocking.push(m);
    }
  }
  const order = CONVERGE_SELF_GRANTABLE_ROLES as readonly string[];
  grant.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { grant, blocking };
}

/** Every permission a converge run relies on after its decision (see the file comment). */
export function convergeAccessChecks(target: {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
}): ConvergeAccessCheck[] {
  const { projectId, region, env } = target;
  const project = { kind: "project", projectId } as const;
  const bucket = opsBucketName(projectId);
  return [
    ...INSTALL_JOB_ROLES.map((role) => ({ resource: project, role, ...INSTALL_ROLE_USES[role] })),
    {
      need: `read and write the install's records and state lock (${OPS_INSTALL_PREFIX}/) and the update's checkpoint (${CONVERGE_STATE_PREFIX}/) in the ops bucket`,
      resource: { kind: "bucket", bucket },
      permissions: [
        "storage.objects.list",
        "storage.objects.get",
        "storage.objects.create",
        "storage.objects.delete",
      ],
    },
    {
      need: "point the converge job at the new release's installer and start it",
      resource: { kind: "run-job", projectId, region, name: convergeJobName(env) },
      permissions: ["run.jobs.get", "run.jobs.update", "run.jobs.run"],
    },
    {
      need: "see whether an earlier run of the converge job has ended",
      resource: project,
      permissions: ["run.executions.get"],
    },
    {
      need: "keep the converge job running as the install's provisioner account",
      resource: {
        kind: "service-account",
        projectId,
        email: provisionerServiceAccountEmail(projectId),
      },
      permissions: ["iam.serviceAccounts.actAs"],
    },
    {
      need: `sign in to the database as its ${UPGRADER_DB_ROLE} login (the update's request and timeline)`,
      resource: project,
      permissions: ["cloudsql.instances.get", "cloudsql.instances.login"],
    },
  ];
}
