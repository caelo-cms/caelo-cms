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
import type { AccessCheck, PreflightVoice } from "./upgrader-iam-preflight.js";
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

/** Every permission a converge run relies on after its decision (see the file comment). */
export function convergeAccessChecks(target: {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
}): AccessCheck[] {
  const { projectId, region, env } = target;
  const project = { kind: "project", projectId } as const;
  const bucket = opsBucketName(projectId);
  return [
    ...INSTALL_JOB_ROLES.map((role) => ({ resource: project, ...INSTALL_ROLE_USES[role] })),
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
