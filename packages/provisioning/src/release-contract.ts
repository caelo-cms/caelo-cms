// SPDX-License-Identifier: MPL-2.0

/**
 * Release-contract constants that every signed release manifest carries
 * (epic #696). They tell an upgrader, without running any code from the
 * new release, whether the release can be installed as an app-roll or
 * needs the operator's own identity.
 *
 * The admin's upgrader job (Phase 2) only rolls images: it holds no IAM
 * write, no secret create, no resource create. Anything a release needs
 * beyond "new image digests + expand-only migrations" must therefore be
 * declared here, so the upgrader refuses it and sends the Owner to the
 * "Run in Cloud Shell" path instead of half-applying it.
 */

/**
 * Version of the infrastructure contract — the IAM bindings, secrets and
 * cloud resources an install must have for this release's images to run.
 *
 * BUMP IT (by one) in any release whose stacks or upgrade-time converge
 * add, remove or change an IAM binding, a Secret Manager secret, a
 * service account, or a cloud resource. An install whose recorded value
 * is lower than a release's cannot take that release as an app-roll.
 *
 * The release pipeline enforces this mechanically: when a file matching
 * {@link INFRA_CONTRACT_PATHS} changed since the previous stable tag and
 * this number did not move, `scripts/release.ts` and `release.yml` refuse
 * the release unless the release cut explicitly records the change as
 * infra-neutral (a comment, a refactor, a test-only edit). See
 * RELEASING.md ("Infra contract").
 */
export const INFRA_CONTRACT_VERSION = 1;

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
  // Upgrade-time mutators outside stack-converge: the upgrade flow itself
  // (it decides which ensure* steps run), the MCP IAP service account +
  // bindings, the default firewall policy.
  "packages/provisioning/src/lifecycle.ts",
  "packages/provisioning/src/mcp-iap.ts",
  "packages/provisioning/src/default-firewall.ts",
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
