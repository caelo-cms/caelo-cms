// SPDX-License-Identifier: MPL-2.0

/**
 * The staging database on an existing GCP install (issue #1329, gateway
 * hardening P3b-1, epic #763 E10).
 *
 * A new install gets `cms_public_staging` and its gateway login
 * `public_staging_role` from the stack (`gcp.sql.Database` / `gcp.sql.User`).
 * An install from before has neither, and an update must bring them
 * without a terminal (CLAUDE.md §11.C): the converge — `cms-provision
 * upgrade` or the in-cloud converge job behind Settings → Updates — runs
 * {@link ensureStagingDatabase} before the migrations, which need the
 * database (migrate.ts `public-staging`, cms_admin migration 0530).
 *
 * Both go through the Cloud SQL Admin API, the way the stack creates them,
 * so the next `pulumi up` adopts the same objects. The database is created
 * with gcloud (no secret involved); the user through the Admin API with the
 * password in the request body (runtime-secrets.ts `ensureDatabaseRolePassword`),
 * read from its CLI-generated secret `public-staging-role-password`, never
 * on argv. The Admin API makes the new user a member of cloudsqlsuperuser;
 * the revoke that follows (public-role-isolation.ts) and the role audit
 * take care of it, as for public_role. Idempotent: an install that has both
 * only gets the password re-applied.
 */

import { findSqlInstance } from "./gateway-credentials.js";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  type EnsureOutcome,
  ensureDatabaseRolePassword,
  type HttpFetch,
} from "./runtime-secrets.js";
import { type GcloudCredentials, lookupFailure } from "./upgrade/gcp-lookup.js";

/** The staging site's database (#1329). */
export const STAGING_DATABASE = "cms_public_staging";

/** The staging gateway's login (#1329). */
export const STAGING_DATABASE_ROLE = "public_staging_role";

/** The names gcloud lists, one per line. */
function names(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Create `cms_public_staging` and `public_staging_role` where the install
 * lacks them, and set the role's password to its secret. Reports instead of
 * throwing; a `failed` outcome names the next step.
 */
export async function ensureStagingDatabase(
  install: {
    readonly projectId: string;
    readonly env: string;
    readonly credentials: GcloudCredentials;
  },
  deps: { readonly run?: GcloudRunner; readonly sleep?: Sleep; readonly http?: HttpFetch } = {},
): Promise<EnsureOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const lookup = await findSqlInstance(install, { run });
  if (lookup.status !== "found") {
    return [
      {
        id: `database ${STAGING_DATABASE}`,
        status: "failed",
        error: lookupFailure(lookup, "Cloud SQL instance", install.credentials),
      },
    ];
  }
  const instance = lookup.name;
  const where = [`--instance=${instance}`, `--project=${install.projectId}`];
  return [
    await ensureDatabase(run, sleep, instance, where),
    await ensureRole(run, deps, install, instance, where),
  ];
}

async function ensureDatabase(
  run: GcloudRunner,
  sleep: Sleep,
  instance: string,
  where: readonly string[],
): Promise<EnsureOutcome> {
  const id = `database ${STAGING_DATABASE}`;
  const listed = await run(["sql", "databases", "list", ...where, "--format=value(name)"]);
  if (!listed.ok) {
    return {
      id,
      status: "failed",
      error: `gcloud sql databases list on ${instance}: ${listed.stderr.trim()}`,
    };
  }
  if (names(listed.stdout).includes(STAGING_DATABASE)) return { id, status: "present" };
  const created = await runWithRetry(run, sleep, [
    "sql",
    "databases",
    "create",
    STAGING_DATABASE,
    ...where,
    "--quiet",
  ]);
  if (!created.ok) {
    return {
      id,
      status: "failed",
      error: `gcloud sql databases create ${STAGING_DATABASE} on ${instance}: ${created.stderr.trim()}. The account running this needs cloudsql.databases.create on the project; re-run once it has.`,
    };
  }
  return { id, status: "applied", detail: `created on ${instance}` };
}

async function ensureRole(
  run: GcloudRunner,
  deps: { readonly sleep?: Sleep; readonly http?: HttpFetch },
  install: { readonly projectId: string; readonly env: string },
  instance: string,
  where: readonly string[],
): Promise<EnsureOutcome> {
  const id = `database role ${STAGING_DATABASE_ROLE}`;
  const listed = await run(["sql", "users", "list", ...where, "--format=value(name)"]);
  if (!listed.ok) {
    return {
      id,
      status: "failed",
      error: `gcloud sql users list on ${instance}: ${listed.stderr.trim()}`,
    };
  }
  const exists = names(listed.stdout).includes(STAGING_DATABASE_ROLE);
  const outcome = await ensureDatabaseRolePassword(
    { projectId: install.projectId, env: install.env, sqlInstance: instance },
    STAGING_DATABASE_ROLE,
    {
      run,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.http ? { http: deps.http } : {}),
      create: !exists,
    },
  );
  if (outcome.status === "failed") return { ...outcome, id };
  return exists
    ? { id, status: "present", detail: "password re-applied" }
    : { id, status: "applied", detail: `created on ${instance}` };
}
