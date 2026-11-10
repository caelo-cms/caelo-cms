// SPDX-License-Identifier: MPL-2.0

/**
 * The Cloud Run jobs that run the admin image: the quality-audit job (#875,
 * admin-core quality/audit-task.ts), the capture job (#1217, admin-core
 * capture/capture-task.ts), the quality-audit runner (#1359), the
 * site-import crawler (#1360) and the build carrier (#1574, all three
 * admin-core reporting-jobs/job-entry.ts).
 * Each refuses an order from an admin on another version, so every app-roll
 * moves them onto the admin's new image right after the services rolled,
 * and a rollback moves them back.
 *
 * `run jobs update --image` changes nothing else of a job (identity, env,
 * parallelism), so this stays inside the app-roll's rights: the upgrader's
 * Cloud Run role plus actAs on each job's service account (upgrader-setup.ts).
 */

import type { GcloudRunner } from "../gcloud-retry.js";
import {
  auditJobName,
  auditRunnerJobName,
  buildCarrierJobName,
  captureJobName,
  importCrawlJobName,
} from "../gcp-names.js";

/** One job that follows the admin's image. */
export interface AdminImageJob {
  /** The job's name (`caelo-<env>-audit`). */
  readonly name: string;
  /** How the upgrade names it (`quality-audit job`). */
  readonly label: string;
  /** What fails while it lags behind the admin. */
  readonly lagging: string;
}

/**
 * The jobs that follow the admin's image, for one environment. The
 * quality-audit runner (#1359) comes after the audit job whose Lighthouse
 * tasks it starts: each refuses work from another version, so the runner
 * never runs on the new image while its tasks still run the old one.
 */
export function adminImageJobs(env: string): readonly AdminImageJob[] {
  return [
    { name: auditJobName(env), label: "quality-audit job", lagging: "Stage audits fail" },
    {
      name: captureJobName(env),
      label: "capture job",
      lagging: "server-side screenshots fail",
    },
    {
      name: auditRunnerJobName(env),
      label: "quality-audit runner",
      lagging: "Stage audits wait for it and fail after their last attempt",
    },
    {
      name: importCrawlJobName(env),
      label: "site-import crawler",
      lagging: "site imports wait for it and fail after their last attempt",
    },
    {
      name: buildCarrierJobName(env),
      label: "build carrier",
      lagging: "an agent's Stage and the Stage and Publish live buttons fail (Stage again)",
    },
  ];
}

interface Install {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
}

/**
 * The job's image now; `image: null` only when the install has no such job
 * yet. Any other gcloud failure (permissions, API, network) is an error, not
 * "no job", so the app-roll reports it instead of a misleading hint.
 */
export async function describeJobImage(
  run: GcloudRunner,
  install: Install,
  job: string,
): Promise<
  | { readonly ok: true; readonly image: string | null }
  | { readonly ok: false; readonly error: string }
> {
  const r = await run([
    "run",
    "jobs",
    "describe",
    job,
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

/** Point a job at `imageRef`. */
export async function setJobImage(
  run: GcloudRunner,
  install: Install,
  job: string,
  imageRef: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const r = await run([
    "run",
    "jobs",
    "update",
    job,
    `--image=${imageRef}`,
    `--region=${install.region}`,
    `--project=${install.projectId}`,
    "--quiet",
  ]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}
