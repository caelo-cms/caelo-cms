// SPDX-License-Identifier: MPL-2.0

/**
 * On-demand Cloud SQL backups (epic #696): the `backup` lifecycle command and
 * the backup every upgrade takes before its migrations. Both GCP providers
 * (`gcp`, `gcp-firebase`) keep their data in the same `caelo-<env>-pg*` Cloud
 * SQL instance, so one implementation serves both.
 *
 * The backup id is what makes the pre-upgrade backup useful: it lands in the
 * upgrade's output and in the restore hint printed when the upgrade has to
 * roll back after migrations ran.
 */

import type { GcloudRunner } from "../gcloud-retry.js";
import { gcpNamePrefix } from "../gcp-names.js";
import { resolveGcpResourceName } from "./gcp-lookup.js";

/** A finished on-demand backup. */
export interface SqlBackup {
  readonly projectId: string;
  /** Cloud SQL instance name (Pulumi-suffixed). */
  readonly instance: string;
  /** Cloud SQL backup run id. */
  readonly backupId: string;
}

export type SqlBackupResult =
  | { readonly ok: true; readonly backup: SqlBackup }
  | { readonly ok: false; readonly error: string };

/**
 * Take an on-demand backup of the install's Cloud SQL instance and return its
 * id. `gcloud sql backups create` waits for the backup to finish but does not
 * print the id in a stable shape, so the backup carries a unique description
 * and is looked up by it afterwards.
 *
 * @param purpose short reason recorded in the backup's description, e.g. "pre-upgrade to 0.11.0"
 */
export async function takeSqlBackup(
  run: GcloudRunner,
  install: { readonly projectId: string; readonly env: string },
  purpose: string,
  now: () => Date = () => new Date(),
): Promise<SqlBackupResult> {
  const instance = await resolveGcpResourceName(
    run,
    "sql-instance",
    `${gcpNamePrefix(install.env)}-pg`,
    install.projectId,
  );
  if (!instance) {
    return {
      ok: false,
      error: `no ${gcpNamePrefix(install.env)}-pg* Cloud SQL instance in project ${install.projectId} (or listing it was denied)`,
    };
  }
  const description = `caelo-cms ${purpose} ${now().toISOString()}`;
  const project = ["--project", install.projectId];
  const create = await run([
    "sql",
    "backups",
    "create",
    "--instance",
    instance,
    ...project,
    "--description",
    description,
  ]);
  if (!create.ok) {
    return { ok: false, error: `backup of ${instance} failed: ${create.stderr.trim()}` };
  }
  const list = await run([
    "sql",
    "backups",
    "list",
    "--instance",
    instance,
    ...project,
    `--filter=description="${description}"`,
    "--format=value(id)",
  ]);
  const backupId = list.ok ? list.stdout.trim().split("\n")[0]?.trim() : "";
  if (!backupId) {
    return {
      ok: false,
      error: `backup of ${instance} was created but its id could not be read (${list.ok ? "no backup carries the description" : list.stderr.trim()}); find it with: gcloud sql backups list --instance=${instance} --project=${install.projectId}`,
    };
  }
  return { ok: true, backup: { projectId: install.projectId, instance, backupId } };
}

/** The command that restores `backup` over its instance (overwrites the current data). */
export function restoreCommand(backup: SqlBackup): string {
  return `gcloud sql backups restore ${backup.backupId} --restore-instance=${backup.instance} --project=${backup.projectId}`;
}

/**
 * What to tell the operator when a pre-upgrade backup failed: why nothing
 * happened, and how to get past it.
 */
export function backupFailureHelp(install: { readonly projectId: string }): string {
  return [
    "Nothing was changed: no migrations ran and no traffic moved.",
    "Fix the cause and re-run upgrade. Common causes:",
    `  - the account lacks Cloud SQL backup rights (roles/cloudsql.editor or owner on ${install.projectId})`,
    "  - another backup or maintenance operation is running on the instance (wait, then retry)",
    `  - the instance is stopped: gcloud sql instances describe <instance> --project=${install.projectId}`,
  ].join("\n");
}
