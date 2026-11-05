// SPDX-License-Identifier: MPL-2.0

/**
 * Whether a `gcp` / `gcp-firebase` stack declares the public data gateway
 * (CLAUDE.md §2, §11.C).
 *
 * The gateway refuses to start while its database login can reach cms_admin
 * or the other environment's public database (apps/api-gateway
 * `databaseIsolationProblems`, #635/#1329), and Cloud Run only finishes
 * creating a service once its container listens. The REVOKEs that isolate
 * the login are migrations (0278, 0530), and the migration job needs the
 * database, the network and the admin service the same stack creates. So a
 * fresh install cannot create everything in one `up`: the first one
 * withholds the gateway, the migrations run, and the next `up` declares it
 * (gateway-bootstrap.ts).
 *
 * Imported by the stacks from `dist/`; keep it free of CLI dependencies.
 */

/** Stack config key (`caelo-<provider>:deployGateways`): `"true"` or `"false"`. */
export const DEPLOY_GATEWAYS_CONFIG = "deployGateways";

/**
 * The stack's reading of {@link DEPLOY_GATEWAYS_CONFIG}. The installer sets
 * it before every `up`. Absent means a stack last configured by an installer
 * from before the key: every such install has run its migrations, so its
 * gateway is declared as it always was — reading "absent" as "withhold"
 * would delete a live gateway on a `state migrate` preview or a manual
 * `pulumi up`.
 *
 * @throws on anything but `"true"`, `"false"` or absent — a typo must not
 *   silently remove the gateway
 */
export function parseDeployGateways(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${DEPLOY_GATEWAYS_CONFIG} must be "true" or "false", got "${value}"`);
}
