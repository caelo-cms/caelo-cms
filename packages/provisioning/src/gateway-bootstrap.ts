// SPDX-License-Identifier: MPL-2.0

/**
 * The installer's order on Google Cloud: no public gateway is deployed onto
 * a database whose migrations have not run (CLAUDE.md §2, §11.C).
 *
 * The data gateway checks at boot that its login cannot reach cms_admin or
 * the other environment's public database, and exits when it can
 * (apps/api-gateway `databaseIsolationProblems`). Cloud SQL leaves CONNECT
 * on every database granted to PUBLIC; the REVOKEs are migrations (0278,
 * 0530), so migrations stay their single source. Cloud Run finishes creating
 * a service only once its container listens, so a `pulumi up` that creates
 * the gateway before the migrations ran fails on every fresh install — and
 * the migration job needs the database, the network and the admin service
 * that very `up` creates.
 *
 * So an install whose gateway has never started runs:
 *
 *   1. `pulumi up` without the gateway (stack-gateways.ts) — the database,
 *      the network, the secrets and the admin;
 *   2. the gateway logins out of cloudsqlsuperuser, then the migrations;
 *   3. `pulumi up` with the gateway, which now starts.
 *
 * An install whose gateway has started at least once has been migrated, and
 * keeps the order it always had: `up` first (which may roll the admin onto
 * the images the run deploys), migrations after. "Has started" is the live
 * service's latest READY revision, not the Pulumi checkpoint: a first run
 * that failed exactly here left a gateway that never started, and the next
 * run must take the three steps, not repeat the failure. The staging gateway
 * is the CLI's and is created after the migrations anyway
 * (staging-gateway-setup.ts); `upgrade` never runs Pulumi and migrates
 * before it rolls any gateway (upgrade/app-roll.ts).
 */

import { isGcloudAuthError } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import { cloudRunServicePrefix, type GcpProvider } from "./stack-contract.js";
import { lookupFailure } from "./upgrade/gcp-lookup.js";

/** Whether the install's data gateway has ever started. */
export type GatewayStart = "started" | "never-started";

/** The install the gateway is looked up on. */
export interface GatewayStartTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
}

/**
 * Whether the live data gateway has a READY revision (Cloud Run's
 * `status.latestReadyRevisionName`): only a gateway that passed its boot
 * check has one. No gateway service at all is "never-started". Read-only.
 *
 * @returns an error (never a guess) when the services cannot be read
 */
export async function readGatewayStart(
  target: GatewayStartTarget,
  run: GcloudRunner,
): Promise<{ ok: true; start: GatewayStart } | { ok: false; error: string }> {
  const prefix = cloudRunServicePrefix(target.provider, GCP_STACK_ENV, "gateway");
  const list = await run([
    "run",
    "services",
    "list",
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    `--filter=metadata.name~^${prefix}`,
    "--format=value(metadata.name)",
  ]);
  if (!list.ok) {
    return {
      ok: false,
      error: lookupFailure(
        { status: "error", stderr: list.stderr, authExpired: isGcloudAuthError(list.stderr) },
        `${prefix}* Cloud Run service`,
        "operator",
      ),
    };
  }
  const names = list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    const ready = await run([
      "run",
      "services",
      "describe",
      name,
      `--region=${target.region}`,
      `--project=${target.projectId}`,
      "--format=value(status.latestReadyRevisionName)",
    ]);
    if (!ready.ok) return { ok: false, error: `describe ${name}: ${ready.stderr.trim()}` };
    if (ready.stdout.trim()) return { ok: true, start: "started" };
  }
  return { ok: true, start: "never-started" };
}

/** The steps {@link deployOntoMigratedDatabase} orders. */
export interface GatewayBootstrapSteps {
  /** `pulumi up` with the stack's `deployGateways` set to the argument. */
  readonly up: (deployGateways: boolean) => Promise<void>;
  /** The gateway logins out of cloudsqlsuperuser, then the migrations. */
  readonly prepareDatabase: () => Promise<void>;
}

/**
 * Run the installer's `pulumi up` so that the gateway is deployed only onto
 * a migrated database (see the module comment).
 *
 * @returns whether the database was prepared here; when not, the caller
 *   runs the migrations after this `up`, as before
 */
export async function deployOntoMigratedDatabase(
  start: GatewayStart,
  steps: GatewayBootstrapSteps,
): Promise<{ readonly databasePrepared: boolean }> {
  if (start === "started") {
    await steps.up(true);
    return { databasePrepared: false };
  }
  await steps.up(false);
  await steps.prepareDatabase();
  await steps.up(true);
  return { databasePrepared: true };
}
