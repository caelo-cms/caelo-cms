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

/** What {@link readGatewayStart} found. */
export type GatewayStartRead =
  | { readonly ok: true; readonly start: "started" }
  | {
      readonly ok: true;
      readonly start: "never-started";
      /** Gateway services that exist but never had a ready revision (a failed first run). */
      readonly neverStarted: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

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
): Promise<GatewayStartRead> {
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
    const ready = await latestReadyRevision(target, name, run);
    if (!ready.ok) return ready;
    if (ready.revision) return { ok: true, start: "started" };
  }
  return { ok: true, start: "never-started", neverStarted: names };
}

async function latestReadyRevision(
  target: GatewayStartTarget,
  name: string,
  run: GcloudRunner,
): Promise<{ ok: true; revision: string } | { ok: false; error: string }> {
  const r = await run([
    "run",
    "services",
    "describe",
    name,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=value(status.latestReadyRevisionName)",
  ]);
  return r.ok
    ? { ok: true, revision: r.stdout.trim() }
    : { ok: false, error: `describe ${name}: ${r.stderr.trim()}` };
}

/**
 * Delete gateway services a failed first run left behind, which never had a
 * ready revision — so never served a request. Run under the install's state
 * lock, right before the `up` that withholds the gateway: Pulumi would
 * delete them in that `up` anyway, but cannot when the operator enabled
 * `deletionProtection`, and a fixed-name one outside the state would block
 * the later create. The `up`'s refresh then drops them from the state.
 * Each is described again first; one that has become ready meanwhile is
 * kept and reported, never deleted.
 *
 * @returns the services deleted, or an error naming the one that stopped it
 */
export async function deleteNeverStartedGateways(
  target: GatewayStartTarget,
  names: readonly string[],
  run: GcloudRunner,
): Promise<{ ok: true; deleted: string[] } | { ok: false; error: string }> {
  const deleted: string[] = [];
  for (const name of names) {
    const ready = await latestReadyRevision(target, name, run);
    if (!ready.ok) return ready;
    if (ready.revision) {
      return {
        ok: false,
        error: `${name} has started meanwhile (revision ${ready.revision}), so another run has deployed the gateway; re-run the installer`,
      };
    }
    const r = await run([
      "run",
      "services",
      "delete",
      name,
      `--region=${target.region}`,
      `--project=${target.projectId}`,
      "--quiet",
    ]);
    if (!r.ok && !/NOT_FOUND|not found|could not be found/i.test(r.stderr)) {
      return { ok: false, error: `delete ${name}: ${r.stderr.trim()}` };
    }
    deleted.push(name);
  }
  return { ok: true, deleted };
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
