// SPDX-License-Identifier: MPL-2.0

/**
 * Release-contract constants that every signed release manifest carries
 * (epic #696). The infrastructure contract number itself lives in
 * infra-contract.ts (shared with the upgrade split's `needsConverge`);
 * this module says which files can change it and the min-from version. They tell an upgrader, without running any code from the
 * new release, whether the release can be installed as an app-roll or
 * needs the operator's own identity.
 *
 * The admin's upgrader job (Phase 2) only rolls images: it holds no IAM
 * write, no secret create, no resource create. Anything a release needs
 * beyond "new image digests + expand-only migrations" must therefore be
 * declared here, so the upgrader refuses it and the admin routes the
 * release to the converge job (#819; the provisioner's identity) instead
 * of half-applying it.
 */

/**
 * Oldest installed version a release can be applied to directly. An
 * install below it has to step through an intermediate release first.
 *
 * Raise it when a release depends on a migration or runtime change that
 * an older install has not been through (the expand/contract rule only
 * guarantees N-1 → N).
 */
export const RELEASE_MIN_FROM_VERSION = "0.10.0";

/**
 * Repo-relative paths (a trailing `/` means "everything below") whose
 * changes can alter the infrastructure contract. Tests and READMEs under
 * them are ignored — see {@link isInfraContractPath}.
 */
export const INFRA_CONTRACT_PATHS: readonly string[] = [
  "packages/provisioning/stacks/",
  "packages/provisioning/src/stack-contract.ts",
  "packages/provisioning/src/stack-converge.ts",
  "packages/provisioning/src/runtime-secrets.ts",
  "packages/provisioning/src/operator-access.ts",
  "packages/provisioning/src/gcp-names.ts",
  // Upgrade-time mutators outside stack-converge: the converge half of the
  // upgrade (it decides which ensure* steps run), the MCP IAP service
  // account + bindings, the default firewall policy.
  "packages/provisioning/src/upgrade/converge.ts",
  "packages/provisioning/src/mcp-iap.ts",
  "packages/provisioning/src/default-firewall.ts",
  // #587 — the admin's URL-map redirects role and the URL map's shape.
  "packages/provisioning/src/url-map-redirects-access.ts",
  "packages/provisioning/src/gcp-url-map.ts",
  // The in-cloud upgrader job's service account, custom roles and bucket
  // grants (#799 added one without the checks noticing).
  "packages/provisioning/src/upgrader-setup.ts",
  // #875 — the quality-audit job, its service account, results bucket and
  // grants.
  "packages/provisioning/src/audit-job-setup.ts",
  // #1217 — the capture job, its service account, bucket and grants.
  "packages/provisioning/src/capture-job-setup.ts",
  // #819 — the converge job, its database login and the admin's grant on it.
  "packages/provisioning/src/converge-job-setup.ts",
  // #891 — the edge security headers the stacks attach, and the converge's
  // SVG backfill + CDN purge on `gcp`.
  "packages/provisioning/src/static-security-headers.ts",
  "packages/provisioning/src/static-svg-gcp.ts",
];

/**
 * Whether a changed repo-relative path can alter the infrastructure
 * contract.
 *
 * @param path - a path as `git diff --name-only` prints it.
 */
export function isInfraContractPath(path: string): boolean {
  if (/\.test\.ts$/.test(path) || /(^|\/)README\.md$/.test(path)) return false;
  return INFRA_CONTRACT_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}
