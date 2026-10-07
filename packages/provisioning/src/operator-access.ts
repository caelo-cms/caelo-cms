// SPDX-License-Identifier: MPL-2.0

/**
 * Converge an existing IAP install onto {@link ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS}
 * — the rights the admin's runtime service account needs to add and remove
 * operators itself when an Owner approves a user change. New installs get
 * the bindings from the Pulumi stacks; `cms-provision upgrade` calls this so
 * installs provisioned earlier get the same, with no operator config.
 *
 * The custom roles themselves are owned here, never by Pulumi: a custom role
 * id is project-global and stays reserved for weeks after deletion, so a
 * Pulumi-declared copy would collide with this one (or with a second stack
 * in the same project). The wizard calls {@link ensureOperatorAccessRoles}
 * before `pulumi up`; the stacks only bind the roles by name.
 *
 * Every step is create-if-missing or an additive IAM binding, so re-running
 * is a no-op. Runs as the operator's gcloud identity (project Owner).
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { type IapResource, iapResourceArgs, mcpIapServiceAccountEmail } from "./mcp-iap.js";
import {
  ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS,
  type CustomRoleSpec,
  customRoleName,
  type IapProvider,
} from "./operator-access-grants.js";

type Run = (args: string[]) => Promise<GcloudResult>;

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

/**
 * Create (or bring to spec) every custom role {@link ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS}
 * uses on `provider`. Idempotent; runs as the operator's gcloud identity.
 */
export async function ensureOperatorAccessRoles(opts: {
  projectId: string;
  provider: IapProvider;
  run?: Run;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const roles = new Set(
    ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS.filter((g) => g.providers.includes(opts.provider)).map(
      (g) => g.role,
    ),
  );
  for (const role of roles) {
    const error = await ensureCustomRole(run, opts.projectId, role);
    if (error) return { ok: false, error };
  }
  return { ok: true };
}

export async function ensureOperatorAccessGrants(opts: {
  projectId: string;
  provider: IapProvider;
  resource: IapResource;
  /** The admin Cloud Run service's runtime service account email. */
  adminServiceAccount: string;
  run?: Run;
}): Promise<{ ok: true; granted: string[] } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const project = `--project=${opts.projectId}`;
  const member = `--member=serviceAccount:${opts.adminServiceAccount}`;
  const grants = ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS.filter((g) =>
    g.providers.includes(opts.provider),
  );

  const roles = await ensureOperatorAccessRoles({
    projectId: opts.projectId,
    provider: opts.provider,
    run,
  });
  if (!roles.ok) return roles;

  const granted: string[] = [];
  for (const grant of grants) {
    const role = `--role=${customRoleName(opts.projectId, grant.role)}`;
    const target =
      grant.scope === "admin-iap-resource"
        ? ["iap", "web", "add-iam-policy-binding", ...iapResourceArgs(opts.resource)]
        : grant.scope === "mcp-service-account"
          ? [
              "iam",
              "service-accounts",
              "add-iam-policy-binding",
              mcpIapServiceAccountEmail(opts.projectId),
            ]
          : ["projects", "add-iam-policy-binding", opts.projectId];
    const r = await run([...target, member, role, "--condition=None", project, "--quiet"]);
    if (!r.ok) {
      return { ok: false, error: `${grant.role.roleId} on ${grant.scope}: ${r.stderr.trim()}` };
    }
    granted.push(`${grant.role.roleId} on ${grant.scope}`);
  }
  return { ok: true, granted };
}
