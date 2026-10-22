// SPDX-License-Identifier: MPL-2.0

/**
 * Moving an existing install's API gateway off admin_role (issue #613),
 * as `cms-provision upgrade` does it. The env side — public_role's own
 * password secret in, every cms_admin credential out (#613, #635) — rides
 * the gateway's roll (stack-contract.ts). The database side is ordered
 * around that roll so /api/* keeps working:
 *
 *   1. right before the gateway rolls: `public_role` moves off admin_role's
 *      password onto its own. Only the gateway logs in as public_role, so
 *      the window in which the old revision cannot open NEW public
 *      connections is the roll itself (open connections stay up).
 *   2. if the gateway's roll fails and it is rolled back: `public_role`
 *      goes back to the password the prior revision reads, so the rollback
 *      leaves a working gateway, not a locked-out one.
 *
 * On every later upgrade the gateway already reads public_role's own
 * secret: step 1 then re-applies the same value (a no-op for clients) and
 * step 2 has nothing to undo.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner, Sleep } from "./gcloud-retry.js";
import { gcpNamePrefix, gcpSecretId } from "./gcp-names.js";
import {
  type DatabaseRoleTarget,
  type EnsureOutcome,
  ensureDatabaseRolePassword,
  type HttpFetch,
  readSecretValue,
} from "./runtime-secrets.js";
import { DATABASE_ROLE_SECRET } from "./stack-contract.js";
import type { LiveEnvValue } from "./stack-converge.js";
import { type GcpLookup, lookupFromListing } from "./upgrade/gcp-lookup.js";

/**
 * Whether this roll moves `public_role` onto its own password: true while
 * the live gateway does not yet read PUBLIC_DATABASE_PASSWORD from the
 * `public-role-password` secret (an install from before #613, where it was
 * admin_role's `postgres-password` or inline in the URL).
 */
export function gatewayMovesPublicRole(
  liveGatewayEnv: ReadonlyMap<string, LiveEnvValue>,
  env: string,
): boolean {
  const live = liveGatewayEnv.get("PUBLIC_DATABASE_PASSWORD");
  const own = gcpSecretId(env, DATABASE_ROLE_SECRET.public_role);
  return !(live?.kind === "secret" && (live.secret === own || live.secret.endsWith(`/${own}`)));
}

export interface GatewayCredentialDeps {
  readonly run?: GcloudRunner;
  readonly sleep?: Sleep;
  readonly http?: HttpFetch;
}

/** Steps 1 and 2 for one roll of the gateway. */
export interface PublicRoleSwitch {
  /** Whether this roll moves public_role off admin_role's password. */
  readonly moves: boolean;
  /** Step 1 — run right before the gateway's `services update`. */
  beforeGatewayRoll(): Promise<EnsureOutcome>;
  /**
   * Step 2 — run when the gateway's roll failed and it goes back to its
   * prior revision. Returns what happened, for the operator.
   */
  afterGatewayRollFailed(): Promise<string>;
}

/** Plan steps 2 and 3 from the gateway's live env (read before the roll). */
export function planPublicRoleSwitch(
  target: DatabaseRoleTarget,
  liveGatewayEnv: ReadonlyMap<string, LiveEnvValue>,
  deps: GatewayCredentialDeps = {},
): PublicRoleSwitch {
  const moves = gatewayMovesPublicRole(liveGatewayEnv, target.env);
  let switched = false;
  return {
    moves,
    async beforeGatewayRoll() {
      const outcome = await ensureDatabaseRolePassword(target, "public_role", deps);
      switched = moves && outcome.status === "applied";
      return outcome;
    },
    async afterGatewayRollFailed() {
      if (!switched) return "public_role was not changed";
      // The prior revision reads admin_role's password for public_role.
      const prior = await readSecretValue(
        deps.run ?? defaultGcloud,
        target,
        DATABASE_ROLE_SECRET.admin_role,
      );
      if (!prior.ok) {
        return `could NOT set public_role back for the rolled-back gateway (${prior.error}); set its password to the latest version of ${gcpSecretId(target.env, "postgres-password")} by hand`;
      }
      const restored = await ensureDatabaseRolePassword(target, "public_role", {
        ...deps,
        password: prior.value,
      });
      if (restored.status !== "applied") {
        return `could NOT set public_role back for the rolled-back gateway (${restored.error ?? "?"}); set its password to the latest version of ${gcpSecretId(target.env, "postgres-password")} by hand`;
      }
      switched = false;
      return "public_role was set back to the password the rolled-back gateway uses";
    },
  };
}

/**
 * The install's Cloud SQL instance (Pulumi suffixes its name). A failed
 * listing comes back as an error with gcloud's stderr, never as "not found"
 * (#630).
 */
export async function findSqlInstance(
  install: { readonly projectId: string; readonly env: string },
  deps: { readonly run?: GcloudRunner } = {},
): Promise<GcpLookup> {
  const run = deps.run ?? defaultGcloud;
  const r = await run([
    "sql",
    "instances",
    "list",
    `--project=${install.projectId}`,
    `--filter=name~^${gcpNamePrefix(install.env)}-pg`,
    "--format=value(name)",
  ]);
  return lookupFromListing(r);
}
