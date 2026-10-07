// SPDX-License-Identifier: MPL-2.0

/**
 * What the admin's runtime service account needs so it can manage operator
 * access on Google IAP installs itself (packages/admin-core/src/security/
 * operator-access/gcp-iap.ts): when an Owner approves creating or deleting a
 * user, the admin allows / removes that person on IAP and on the MCP service
 * account, with no `cms-provision` round-trip.
 *
 * Least privilege: a project custom role holding ONLY get/setIamPolicy,
 * bound on exactly two resources — the admin's own IAP resource and the
 * `caelo-mcp` service account. Not `roles/iap.admin` (which also edits IAP
 * settings and tunnels) and not `roles/iam.serviceAccountAdmin` (which can
 * also delete or disable the account). On `gcp` the admin additionally needs
 * to find its LB backend service — the Pulumi-generated name is unknowable
 * from inside the admin service it fronts — so a second custom role carries
 * `compute.backendServices.list` alone, at project level (list has no
 * narrower scope).
 *
 * Kept free of imports: the Pulumi stacks read it from `dist/` (like
 * bootstrap-token.ts), and the convergence code in `cms-provision upgrade`
 * applies the same list to installs provisioned before it existed.
 */

/**
 * A project-level custom role. Created by the CLI (the wizard before
 * `pulumi up`, and `upgrade`), never declared in the stacks — see
 * operator-access.ts.
 */
export interface CustomRoleSpec {
  readonly roleId: string;
  readonly title: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

export const OPERATOR_ACCESS_ROLE: CustomRoleSpec = {
  roleId: "caeloOperatorAccess",
  title: "Caelo operator access",
  description:
    "Lets the Caelo admin add and remove operators on its own IAP resource and on the caelo-mcp service account. Bound only on those two resources.",
  permissions: [
    "iap.webServices.getIamPolicy",
    "iap.webServices.setIamPolicy",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.setIamPolicy",
  ],
};

export const ADMIN_IAP_LOOKUP_ROLE: CustomRoleSpec = {
  roleId: "caeloAdminIapLookup",
  title: "Caelo admin IAP lookup",
  description:
    "Lets the Caelo admin find its own IAP-enabled load-balancer backend service by name (gcp provider only).",
  permissions: ["compute.backendServices.list"],
};

export type IapProvider = "gcp" | "gcp-firebase";

/** One binding of a custom role to the admin's runtime service account. */
export interface AdminRuntimeGrant {
  readonly role: CustomRoleSpec;
  /** Which resource the binding sits on. */
  readonly scope: "admin-iap-resource" | "mcp-service-account" | "project";
  readonly providers: readonly IapProvider[];
}

/**
 * Every binding the admin's runtime service account needs for operator
 * access. The single list both the stacks and stack convergence follow.
 */
export const ADMIN_RUNTIME_OPERATOR_ACCESS_GRANTS: readonly AdminRuntimeGrant[] = [
  { role: OPERATOR_ACCESS_ROLE, scope: "admin-iap-resource", providers: ["gcp", "gcp-firebase"] },
  { role: OPERATOR_ACCESS_ROLE, scope: "mcp-service-account", providers: ["gcp", "gcp-firebase"] },
  { role: ADMIN_IAP_LOOKUP_ROLE, scope: "project", providers: ["gcp"] },
];

/** `projects/<project>/roles/<roleId>` — the name IAM bindings reference. */
export function customRoleName(projectId: string, role: CustomRoleSpec): string {
  return `projects/${projectId}/roles/${role.roleId}`;
}
