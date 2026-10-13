// SPDX-License-Identifier: MPL-2.0

/**
 * A Cloud SQL IAM database user for one of the install's in-cloud jobs
 * (the operator-access sync job, the upgrader job): IAM database
 * authentication switched on for the instance, the job's service account
 * as a `cloud_iam_service_account` user, and that user made a member of
 * exactly one database role a migration created for it. No password ever
 * exists; the job logs in with its short-lived access token.
 */

import type { GcloudResult } from "./gcloud.js";
import { gcpNamePrefix } from "./gcp-names.js";

type Run = (args: string[]) => Promise<GcloudResult>;

/** The flags of a Cloud SQL instance with `cloudsql.iam_authentication` on. */
export function withIamAuthFlag(
  flags: readonly { name: string; value: string }[],
): { name: string; value: string }[] | null {
  if (flags.some((f) => f.name === "cloudsql.iam_authentication" && f.value === "on")) return null;
  return [
    ...flags.filter((f) => f.name !== "cloudsql.iam_authentication"),
    { name: "cloudsql.iam_authentication", value: "on" },
  ];
}

export type CloudSqlIamUserResult =
  | { readonly ok: true; readonly done: string[] }
  | { readonly ok: false; readonly done: string[]; readonly error: string };

/**
 * Ensure `serviceAccountEmail` logs in to the install's Cloud SQL instance
 * as an IAM database user holding `databaseRole`. Idempotent; never throws
 * for a gcloud failure.
 */
export async function ensureCloudSqlIamUser(
  run: Run,
  opts: {
    readonly projectId: string;
    readonly env: string;
    readonly serviceAccountEmail: string;
    readonly databaseRole: string;
  },
): Promise<CloudSqlIamUserResult> {
  const project = `--project=${opts.projectId}`;
  const done: string[] = [];
  const fail = (step: string, r: GcloudResult): CloudSqlIamUserResult => ({
    ok: false,
    done,
    error: `${step}: ${r.stderr.trim()}`,
  });
  const instances = await run([
    "sql",
    "instances",
    "list",
    project,
    `--filter=name~^${gcpNamePrefix(opts.env)}-pg`,
    "--format=value(name)",
  ]);
  if (!instances.ok) return fail("list Cloud SQL instances", instances);
  const names = instances.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length !== 1) {
    return {
      ok: false,
      done,
      error: `expected exactly one ${gcpNamePrefix(opts.env)}-pg* Cloud SQL instance, found ${names.length} (${names.join(", ")})`,
    };
  }
  const instance = names[0] as string;
  const flagsJson = await run([
    "sql",
    "instances",
    "describe",
    instance,
    project,
    "--format=json(settings.databaseFlags)",
  ]);
  if (!flagsJson.ok) return fail(`read the flags of ${instance}`, flagsJson);
  const flags =
    (
      JSON.parse(flagsJson.stdout) as {
        settings?: { databaseFlags?: { name: string; value: string }[] };
      }
    ).settings?.databaseFlags ?? [];
  const nextFlags = withIamAuthFlag(flags);
  if (nextFlags) {
    // `--database-flags` replaces the whole list, so every existing flag is
    // passed again. cloudsql.iam_authentication needs no restart.
    const patch = await run([
      "sql",
      "instances",
      "patch",
      instance,
      project,
      `--database-flags=${nextFlags.map((f) => `${f.name}=${f.value}`).join(",")}`,
      "--quiet",
    ]);
    if (!patch.ok) return fail(`enable IAM database authentication on ${instance}`, patch);
    done.push(`${instance}: cloudsql.iam_authentication=on`);
  }
  const dbUser = opts.serviceAccountEmail.replace(/\.gserviceaccount\.com$/, "");
  const users = await run([
    "sql",
    "users",
    "list",
    `--instance=${instance}`,
    project,
    "--format=value(name)",
  ]);
  if (!users.ok) return fail(`list database users of ${instance}`, users);
  if (
    !users.stdout
      .split("\n")
      .map((s) => s.trim())
      .includes(dbUser)
  ) {
    const create = await run([
      "sql",
      "users",
      "create",
      dbUser,
      `--instance=${instance}`,
      "--type=cloud_iam_service_account",
      project,
      "--quiet",
    ]);
    if (!create.ok) return fail(`create database user ${dbUser}`, create);
  }
  const assign = await run([
    "sql",
    "users",
    "assign-roles",
    dbUser,
    `--instance=${instance}`,
    "--type=cloud_iam_service_account",
    `--database-roles=${opts.databaseRole}`,
    project,
    "--quiet",
  ]);
  if (!assign.ok) return fail(`give ${dbUser} the ${opts.databaseRole} database role`, assign);
  done.push(`database user ${dbUser} (${opts.databaseRole})`);
  return { ok: true, done };
}
