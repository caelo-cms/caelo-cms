// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's side of "Install update" on Google Cloud installs (epic #696):
 * it can START the upgrader job — or, for a release that changes the cloud
 * setup, the converge job (#819) — and read how their runs went. Nothing
 * else.
 *
 * Same trust boundary as the operator-access job (gcp-job-trigger.ts): the
 * admin's runtime service account holds `roles/run.jobsExecutor` on each
 * job — `run.jobs.run` without `run.jobs.runWithOverrides` — and
 * `roles/run.viewer` on it (packages/provisioning/src/upgrader-setup.ts,
 * converge-job-setup.ts). The start call carries no body: the admin may
 * not, and cannot, pass a job arguments, env or another image. What a job
 * installs it decides itself from the request row and the signed release
 * manifest.
 */

import { defaultGoogleDeps, type GoogleDeps, googleCall } from "../operator-access/google-iam.js";

/** Why the upgrader job could not be started, with what to do about it. */
export class UpgraderTriggerError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = "UpgraderTriggerError";
  }
}

/** How a run of the upgrader job went (Cloud Run's view; the timeline is in the database). */
export interface UpgraderExecution {
  readonly execution: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly completedAt?: string;
  /** Cloud Console page with the run's log. */
  readonly logsUrl: string;
}

/** Starts the upgrader job and reads its latest run. */
export interface UpgraderTrigger {
  /** Start a run; returns its short execution id. */
  start(): Promise<string>;
  /** The most recent run, or null when it never ran. */
  latest(): Promise<UpgraderExecution | null>;
}

export interface UpgraderJobEnv {
  readonly CAELO_PROVIDER?: string;
  /** `projects/<id>/locations/<region>/jobs/<job>` (stack-contract.ts adminEnvContract). */
  readonly CAELO_UPGRADER_JOB?: string;
}

/** The admin env naming the converge job (#819). */
export interface ConvergeJobEnv {
  readonly CAELO_PROVIDER?: string;
  /** `projects/<id>/locations/<region>/jobs/<job>` (stack-contract.ts adminEnvContract). */
  readonly CAELO_CONVERGE_JOB?: string;
}

/** What the Owner does when the job is missing or the admin may not start it. */
export const UPGRADER_SETUP_HINT =
  "Run the upgrade once from Cloud Shell or the computer you installed from (Settings → Updates shows the command): it sets up the upgrader and lets the admin start it.";

/** The same for the converge job (#819). */
export const CONVERGE_SETUP_HINT =
  "Run the upgrade once from Cloud Shell or the computer you installed from (Settings → Updates shows the command): it sets up the converge job, so later updates that change the cloud setup install from here.";

const JOB_NAME = /^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/;

const lastSegment = (name: string): string => name.split("/").pop() ?? name;

/**
 * The trigger for this admin, or null when it has none: not a Google Cloud
 * install, or `CAELO_UPGRADER_JOB` unset (an install the job was never set
 * up on) — the page then shows the command to run instead.
 *
 * @throws UpgraderTriggerError when the variable is set but malformed
 */
export function upgraderTriggerFromEnv(
  env: UpgraderJobEnv,
  deps: GoogleDeps = defaultGoogleDeps(),
): UpgraderTrigger | null {
  return cloudRunJobTrigger(
    env.CAELO_PROVIDER,
    { variable: "CAELO_UPGRADER_JOB", value: env.CAELO_UPGRADER_JOB },
    { label: "upgrader job", setupHint: UPGRADER_SETUP_HINT },
    deps,
  );
}

/**
 * The converge job's trigger (#819), or null when this install has none:
 * not a Google Cloud install, or `CAELO_CONVERGE_JOB` unset (installed
 * before the job existed, or its setup failed) — such releases then
 * install from a terminal.
 *
 * @throws UpgraderTriggerError when the variable is set but malformed
 */
export function convergeTriggerFromEnv(
  env: ConvergeJobEnv,
  deps: GoogleDeps = defaultGoogleDeps(),
): UpgraderTrigger | null {
  return cloudRunJobTrigger(
    env.CAELO_PROVIDER,
    { variable: "CAELO_CONVERGE_JOB", value: env.CAELO_CONVERGE_JOB },
    { label: "converge job", setupHint: CONVERGE_SETUP_HINT },
    deps,
  );
}

/** A start-only trigger for the Cloud Run job the env variable names. */
function cloudRunJobTrigger(
  provider: string | undefined,
  name: { readonly variable: string; readonly value: string | undefined },
  wording: { readonly label: string; readonly setupHint: string },
  deps: GoogleDeps,
): UpgraderTrigger | null {
  if (provider !== "gcp" && provider !== "gcp-firebase") return null;
  const job = name.value?.trim() ?? "";
  if (!job) return null;
  const parts = JOB_NAME.exec(job);
  if (!parts) {
    throw new UpgraderTriggerError(
      `${name.variable} is not a Cloud Run job name: ${job}`,
      wording.setupHint,
    );
  }
  const [, project, region] = parts;
  const api = `https://run.googleapis.com/v2/${job}`;
  const logsUrl = (execution: string) =>
    `https://console.cloud.google.com/run/jobs/executions/details/${region}/${execution}/logs?project=${project}`;
  const call = async (url: string, method: "GET" | "POST", body?: unknown) => {
    try {
      return await googleCall(deps, url, method, body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new UpgraderTriggerError(
        `the ${wording.label} could not be reached: ${message}`,
        /HTTP (403|404)/.test(message) ? wording.setupHint : "Try again in a moment.",
      );
    }
  };
  return {
    async start() {
      // No body: no overrides — the admin has no permission for any.
      const op = (await call(`${api}:run`, "POST", {})) as { metadata?: { name?: string } };
      const name = op.metadata?.name;
      if (!name) {
        throw new UpgraderTriggerError(
          `the ${wording.label} started but Google returned no execution name.`,
          "Reload Settings → Updates in a minute; the timeline shows whether it runs.",
        );
      }
      return lastSegment(name);
    },
    async latest() {
      const ref = (
        (await call(api, "GET")) as {
          latestCreatedExecution?: {
            name?: string;
            completionTime?: string;
            completionStatus?: string;
          };
        }
      ).latestCreatedExecution;
      if (!ref?.name) return null;
      const execution = lastSegment(ref.name);
      const state: UpgraderExecution["state"] =
        ref.completionStatus === "EXECUTION_SUCCEEDED"
          ? "succeeded"
          : ref.completionStatus === "EXECUTION_FAILED"
            ? "failed"
            : ref.completionStatus === "EXECUTION_CANCELLED"
              ? "cancelled"
              : "running";
      return {
        execution,
        state,
        ...(ref.completionTime ? { completedAt: ref.completionTime } : {}),
        logsUrl: logsUrl(execution),
      };
    },
  };
}
