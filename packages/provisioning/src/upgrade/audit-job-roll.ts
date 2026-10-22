// SPDX-License-Identifier: MPL-2.0

/**
 * #875 — the quality-audit job runs the admin image (admin-core
 * quality/audit-task.ts) and refuses a batch from an admin on another
 * version. So every app-roll moves the job onto the admin's new image right
 * after the services rolled, and a rollback moves it back.
 *
 * `run jobs update --image` changes nothing else of the job (identity, env,
 * parallelism), so this stays inside the app-roll's rights: the upgrader's
 * `roles/run.developer` plus actAs on the job's service account
 * (upgrader-setup.ts).
 */

import type { GcloudRunner } from "../gcloud-retry.js";
import { auditJobName } from "../gcp-names.js";

/**
 * The job's image now; `image: null` only when the install has no audit job
 * yet. Any other gcloud failure (permissions, API, network) is an error, not
 * "no job", so the app-roll reports it instead of a misleading hint.
 */
export async function describeAuditJobImage(
  run: GcloudRunner,
  install: { readonly projectId: string; readonly region: string; readonly env: string },
): Promise<
  | { readonly ok: true; readonly image: string | null }
  | { readonly ok: false; readonly error: string }
> {
  const r = await run([
    "run",
    "jobs",
    "describe",
    auditJobName(install.env),
    `--region=${install.region}`,
    `--project=${install.projectId}`,
    "--format=value(spec.template.spec.template.spec.containers[0].image)",
  ]);
  if (!r.ok) {
    // gcloud's own wording for a missing job is "Cannot find job [<name>]."
    // (no NOT_FOUND code), so match that too.
    return /NOT_FOUND|not found|could not be found|cannot find/i.test(r.stderr)
      ? { ok: true, image: null }
      : { ok: false, error: r.stderr.trim() };
  }
  const image = r.stdout.trim();
  if (image.length === 0) {
    return { ok: false, error: "the job's description names no container image" };
  }
  return { ok: true, image };
}

/** Point the audit job at `imageRef`. */
export async function setAuditJobImage(
  run: GcloudRunner,
  install: { readonly projectId: string; readonly region: string; readonly env: string },
  imageRef: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const r = await run([
    "run",
    "jobs",
    "update",
    auditJobName(install.env),
    `--image=${imageRef}`,
    `--region=${install.region}`,
    `--project=${install.projectId}`,
    "--quiet",
  ]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}
