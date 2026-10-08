// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's side of operator access on Google IAP installs (`gcp`,
 * `gcp-firebase`): it can START the operator-access sync job and read how
 * runs went — nothing else.
 *
 * Trust boundary (CLAUDE.md §11.B Tier 2): the admin's runtime service
 * account holds no IAM-policy rights at all. A Cloud Run job with its own
 * service account (sync-job.ts) is the only principal that may change who
 * passes IAP or may sign as `caelo-mcp`; it recomputes that from the user
 * list and only ever grants individual `user:` emails. The admin holds
 * `roles/run.jobsExecutor` on that one job — `run.jobs.run` without
 * `run.jobs.runWithOverrides` (cloud.google.com/run/docs/reference/iam/roles),
 * so it cannot change the job's command, env or arguments — plus
 * `roles/run.viewer` on the job to read the latest execution's outcome. A
 * compromised admin can therefore add users to the database (and so to IAP,
 * one email at a time), but cannot make IAP public or grant any other role.
 */

import { defaultGoogleDeps, type GoogleDeps, googleCall } from "./google-iam.js";

/** An operator-access change that could not be made, with what to do about it. */
export class OperatorAccessError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = "OperatorAccessError";
  }
}

/** How a run of the sync job went. */
export interface ExecutionState {
  /** Short execution id, e.g. `caelo-production-operator-access-sync-abc12`. */
  readonly execution: string;
  readonly state: "running" | "succeeded" | "failed" | "cancelled";
  readonly completedAt?: string;
  /** Cloud Console page with the execution's log (what was granted/removed, or why it failed). */
  readonly logsUrl: string;
}

/** Starts the sync job and reports on its runs. */
export interface OperatorAccessTrigger {
  /** Human-readable target, e.g. "Google IAP (operator-access sync job)". */
  readonly label: string;
  /** Start a run; returns its short execution id. */
  start(): Promise<string>;
  /** Wait for `execution` to finish, up to `timeoutMs`; `running` if it did not. */
  wait(execution: string, timeoutMs: number): Promise<ExecutionState>;
  /** The most recent run (from the admin or the hourly schedule), or `null` if none yet. */
  latest(): Promise<ExecutionState | null>;
}

export interface GcpJobEnv {
  readonly CAELO_PROVIDER?: string;
  /** `projects/<id>/locations/<region>/jobs/<job>` (stack-contract.ts adminEnvContract). */
  readonly CAELO_OPERATOR_ACCESS_JOB?: string;
}

/** Next step when the install has no sync job (or the admin may not start it). */
export const UPGRADE_HINT =
  "Run `cms-provision upgrade` from the machine that provisioned this install: it sets up the operator-access sync job and lets the admin start it.";

/**
 * Next step once the cause of a failed run is fixed. The user change itself
 * is saved; the job always recomputes everyone, so any later run repairs it.
 */
export const RESYNC_HINT =
  'Then open /security/users and click "Re-sync Google IAP access" (the job also re-runs every hour on its own) — the user change itself is already saved.';

const JOB_NAME = /^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/;

interface ExecutionReference {
  name?: string;
  completionTime?: string;
  completionStatus?: string;
}

const lastSegment = (name: string): string => name.split("/").pop() ?? name;

/**
 * The trigger for this process, or `null` when the admin is not behind Google
 * IAP (self-hosted, AWS, Azure) — there is nothing to sync there.
 */
export function gcpJobTriggerFromEnv(
  env: GcpJobEnv,
  deps: GoogleDeps = defaultGoogleDeps(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): OperatorAccessTrigger | null {
  if (env.CAELO_PROVIDER !== "gcp" && env.CAELO_PROVIDER !== "gcp-firebase") return null;
  const label = "Google IAP (operator-access sync job)";
  const job = env.CAELO_OPERATOR_ACCESS_JOB?.trim() ?? "";
  const parts = JOB_NAME.exec(job);
  if (!parts) {
    const fail = (): never => {
      throw new OperatorAccessError(
        job
          ? `CAELO_OPERATOR_ACCESS_JOB is not a Cloud Run job name: ${job}`
          : "CAELO_OPERATOR_ACCESS_JOB is not set on the admin, so it cannot start the operator-access sync job.",
        UPGRADE_HINT,
      );
    };
    return {
      label,
      start: async () => fail(),
      wait: async () => fail(),
      latest: async () => fail(),
    };
  }
  const [, project, region] = parts;
  const logsUrl = (execution: string) =>
    `https://console.cloud.google.com/run/jobs/executions/details/${region}/${execution}/logs?project=${project}`;
  const api = `https://run.googleapis.com/v2/${job}`;

  const call = async (url: string, method: "GET" | "POST", body?: unknown) => {
    try {
      return await googleCall(deps, url, method, body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new OperatorAccessError(
        `the operator-access sync job could not be reached: ${message}`,
        /HTTP (403|404)/.test(message) ? UPGRADE_HINT : `Try again in a moment. ${RESYNC_HINT}`,
      );
    }
  };
  const readLatest = async (): Promise<ExecutionReference | undefined> =>
    ((await call(api, "GET")) as { latestCreatedExecution?: ExecutionReference })
      .latestCreatedExecution;
  const stateOf = (ref: ExecutionReference): ExecutionState["state"] => {
    switch (ref.completionStatus) {
      case "EXECUTION_SUCCEEDED":
        return "succeeded";
      case "EXECUTION_FAILED":
        return "failed";
      case "EXECUTION_CANCELLED":
        return "cancelled";
      default:
        return "running";
    }
  };
  const toState = (ref: ExecutionReference): ExecutionState => {
    const execution = lastSegment(ref.name ?? "");
    return {
      execution,
      state: stateOf(ref),
      ...(ref.completionTime ? { completedAt: ref.completionTime } : {}),
      logsUrl: logsUrl(execution),
    };
  };

  return {
    label,
    async start() {
      // No body: the admin may not override anything, and has no permission to.
      const op = (await call(`${api}:run`, "POST", {})) as { metadata?: { name?: string } };
      const name = op.metadata?.name;
      if (!name) {
        throw new OperatorAccessError(
          "the operator-access sync job started but Google returned no execution name.",
          RESYNC_HINT,
        );
      }
      return lastSegment(name);
    },
    async wait(execution, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const ref = await readLatest();
        if (ref?.name && lastSegment(ref.name) === execution) {
          const s = toState(ref);
          if (s.state !== "running") return s;
        } else if (ref?.name) {
          // A newer run (the schedule, another click) started after ours; it
          // recomputes the same state, so ours is no longer the one to watch.
          return { execution, state: "running", logsUrl: logsUrl(execution) };
        }
        if (Date.now() >= deadline) {
          return { execution, state: "running", logsUrl: logsUrl(execution) };
        }
        await sleep(3_000);
      }
    },
    async latest() {
      const ref = await readLatest();
      return ref?.name ? toState(ref) : null;
    },
  };
}
