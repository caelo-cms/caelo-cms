// SPDX-License-Identifier: MPL-2.0

/**
 * Take `public_role` out of `cloudsqlsuperuser` (issue #633, CLAUDE.md §2).
 *
 * The stacks declare `public_role` as a Cloud SQL Admin API user
 * (`gcp.sql.User`), and Cloud SQL makes every such user a member of
 * `cloudsqlsuperuser` — the group that owns cms_admin and cms_public. That
 * gave the API gateway's visitor-facing login the owner group's rights.
 *
 * Why the Admin API and not SQL: on PostgreSQL 16+ a role membership can
 * only be revoked by the role that granted it (or a superuser), and here
 * that is Cloud SQL's own administrator, not `admin_role` — a `REVOKE` from
 * the migration job would leave the membership in place with a warning.
 * `users.update` with `revokeExistingRoles` runs as that administrator. It
 * is also the one path that works the same for a fresh install and for the
 * installs out there, with no change to the Pulumi resource (re-creating the
 * user in SQL would mean deleting a user the stacks' state owns, with
 * dependent grants in both databases, while the gateway serves on it).
 *
 * Revoking every role leaves `public_role` with none, which is exactly its
 * contract: its rights are object grants in cms_public, nothing else.
 *
 * The CLI cannot reach the private-IP database to check the result, so the
 * check runs where SQL runs: the migration job's role audit
 * (packages/migrations/src/role-audit.ts), which fails the migration — and
 * with it the install or upgrade, before any traffic moves — while
 * `public_role` is still a member of any role. This step therefore runs
 * BEFORE migrations, on every install pass and every `upgrade`. Idempotent:
 * revoking from a role that has none changes nothing.
 *
 * Since #1329 the staging gateway's login `public_staging_role` is an
 * Admin API user too and gets the same revoke.
 */

import { findSqlInstance } from "./gateway-credentials.js";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import type { EnsureOutcome } from "./runtime-secrets.js";
import { type GcloudCredentials, lookupFailure } from "./upgrade/gcp-lookup.js";

/** The gateway logins the Admin API created, which must hold no database role (#633, #1329). */
export const GATEWAY_DATABASE_LOGINS = ["public_role", "public_staging_role"] as const;

/** The gcloud call that leaves a gateway login with no database roles. */
export function revokePublicRoleMembershipsArgs(target: {
  readonly projectId: string;
  readonly sqlInstance: string;
  readonly role: (typeof GATEWAY_DATABASE_LOGINS)[number];
}): string[] {
  return [
    "sql",
    "users",
    "assign-roles",
    target.role,
    `--instance=${target.sqlInstance}`,
    "--type=BUILT_IN",
    "--revoke-existing-roles",
    `--project=${target.projectId}`,
    "--quiet",
  ];
}

/**
 * Revoke every database role the Admin API gave the gateway logins
 * ({@link GATEWAY_DATABASE_LOGINS}). Reports instead of throwing; `failed`
 * names the next step.
 */
export async function revokePublicRoleMemberships(
  install: {
    readonly projectId: string;
    readonly env: string;
    readonly credentials: GcloudCredentials;
  },
  deps: { readonly run?: GcloudRunner; readonly sleep?: Sleep } = {},
): Promise<EnsureOutcome> {
  const run = deps.run ?? defaultGcloud;
  const id = "gateway logins' database role memberships";
  const lookup = await findSqlInstance(install, { run });
  if (lookup.status !== "found") {
    return {
      id,
      status: "failed",
      error: lookupFailure(lookup, "Cloud SQL instance", install.credentials),
    };
  }
  const sqlInstance = lookup.name;
  for (const role of GATEWAY_DATABASE_LOGINS) {
    const r = await runWithRetry(
      run,
      deps.sleep ?? realSleep,
      revokePublicRoleMembershipsArgs({ projectId: install.projectId, sqlInstance, role }),
    );
    if (!r.ok) {
      return {
        id,
        status: "failed",
        error: `gcloud sql users assign-roles ${role} --revoke-existing-roles on ${sqlInstance}: ${r.stderr.trim()}. The account running this needs cloudsql.users.update on the project; re-run once it has.`,
      };
    }
  }
  return {
    id,
    status: "applied",
    detail: `${GATEWAY_DATABASE_LOGINS.join(" and ")} hold no database roles on ${sqlInstance}`,
  };
}
