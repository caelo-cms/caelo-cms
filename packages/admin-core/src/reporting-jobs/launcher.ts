// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — starting a reporting job's attempt, on whatever runs it on
 * this install:
 *
 *   gcp, gcp-firebase  one execution of the kind's Cloud Run job (the admin
 *                      image, the job's own service account, no database,
 *                      no secret), started with its order as an env
 *                      override — the admin's run SA may run that job with
 *                      overrides and do nothing else with it.
 *   self-hosted, dev   the same job main inside the admin's process
 *                      (in-process.ts): no extra machines; the self-hosted
 *                      admin has CPU between requests.
 *   aws, azure         nowhere yet: the work is recorded as failed with the
 *                      tracking issue (#749, #750), never run in the admin
 *                      instead.
 *
 * A start mints a fresh token, records the attempt with the token's hash
 * and a first lease (`reporting_jobs.begin_attempt`), then launches. A
 * launch that fails releases the lease at once, so the next tick's backstop
 * tries again; the backstop gives the work up after the kind's last
 * attempt (backstop.ts).
 */

import { execute } from "@caelo-cms/query-api";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";
import { type AdminJobDeps, REPORTING_JOB_CTX, type ReportingJobKindDef } from "./kind.js";
import { reportingJobKind } from "./kinds.js";
import {
  hashJobToken,
  JOB_ORDER_ENV_VAR,
  JOB_TIMING,
  type JobOrder,
  mintJobToken,
  type ReportingJobKind,
  reportOrigin,
} from "./protocol.js";

/** Starts one attempt's execution. */
export interface JobLauncher {
  /** Names where it runs in messages (`Cloud Run job caelo-production-audit-run`). */
  readonly label: string;
  /** Start the attempt; resolves with where it runs (an execution name). */
  launch(order: JobOrder): Promise<string>;
}

const JOB_NAME = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/;

/**
 * The launcher of a kind's Cloud Run job.
 *
 * @param job - the job's full resource name.
 * @param adminUrl - the admin's origin behind IAP, where the job reports.
 */
export function gcpReportingJobLauncher(
  kind: ReportingJobKind,
  job: string,
  adminUrl: string,
  deps: GoogleDeps = defaultGoogleDeps(),
): JobLauncher {
  if (!JOB_NAME.test(job)) throw new Error(`not a Cloud Run job name: ${job}`);
  const origin = reportOrigin(adminUrl);
  return {
    label: `Cloud Run job ${job.split("/").pop()}`,
    async launch(order) {
      const op = (await googleCall(deps, `https://run.googleapis.com/v2/${job}:run`, "POST", {
        overrides: {
          taskCount: 1,
          timeout: `${JOB_TIMING[kind].maxRunSeconds}s`,
          containerOverrides: [
            {
              env: [
                { name: JOB_ORDER_ENV_VAR, value: JSON.stringify({ ...order, adminUrl: origin }) },
              ],
            },
          ],
        },
      })) as { metadata?: { name?: string } };
      const name = op.metadata?.name;
      if (!name) throw new Error("Cloud Run started the job but returned no execution name");
      return name;
    },
  };
}

let inProcess: ((kind: ReportingJobKind) => JobLauncher) | null = null;

/**
 * Register how this admin process runs jobs itself (self-hosted and
 * development, from hooks.server.ts; null removes it). Without it — a test,
 * a script — work on those installs is left for whoever drives it.
 */
export function setInProcessJobLauncher(
  next: ((kind: ReportingJobKind) => JobLauncher) | null,
): void {
  inProcess = next;
}

/** How an install runs a kind's jobs. */
export type LauncherChoice =
  | { readonly kind: "launcher"; readonly launcher: JobLauncher }
  /** It cannot run them; the work is given up with this message. */
  | { readonly kind: "unavailable"; readonly message: string }
  /** Nothing in this process runs them (in-process not registered). */
  | { readonly kind: "none" };

/** The launcher of `def`'s jobs for an admin with this environment. */
export function launcherFor(
  def: ReportingJobKindDef,
  env: Record<string, string | undefined> = process.env,
): LauncherChoice {
  const provider = env.CAELO_PROVIDER ?? "";
  if (provider === "" || provider === "self-hosted") {
    return inProcess ? { kind: "launcher", launcher: inProcess(def.kind) } : { kind: "none" };
  }
  if (provider === "gcp" || provider === "gcp-firebase") {
    const job = env[def.gcp.jobEnvVar]?.trim();
    const adminUrl = env.CAELO_ADMIN_URL?.trim();
    if (!job || !adminUrl) {
      return {
        kind: "unavailable",
        message: `the ${def.label} has no job on this install (${def.gcp.jobEnvVar} / CAELO_ADMIN_URL missing on the admin) — the operator runs \`cms-provision upgrade\`, then retries`,
      };
    }
    try {
      return { kind: "launcher", launcher: gcpReportingJobLauncher(def.kind, job, adminUrl) };
    } catch (e) {
      return { kind: "unavailable", message: e instanceof Error ? e.message : String(e) };
    }
  }
  if (provider === "aws" || provider === "azure") {
    return {
      kind: "unavailable",
      message: `the ${def.label} has no job on provider "${provider}" yet (${def.pendingIssue[provider]}); it is recorded as failed so the gap stays visible, never run inside the admin instead`,
    };
  }
  return { kind: "unavailable", message: `unknown provider "${provider}" for the ${def.label}` };
}

/** How a start went. */
export type StartOutcome =
  | { readonly outcome: "started"; readonly attempt: number; readonly execution: string }
  /** The launch failed; the lease is released and the backstop retries. */
  | { readonly outcome: "launch-failed"; readonly attempt: number; readonly message: string }
  /** Another attempt holds the lease, or the work is over: nothing to start. */
  | { readonly outcome: "running" | "finished" }
  /** The last attempt died, or the install cannot run it: recorded as failed. */
  | { readonly outcome: "given-up"; readonly message: string }
  | { readonly outcome: "no-launcher" };

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

/**
 * How long a launch may take. It runs inside the request that started the
 * work (a Stage), which must not hang on the provider: an execution that
 * did start anyway is replaced by the next attempt, whose start makes the
 * late one's reports stale.
 */
const LAUNCH_TIMEOUT_MS = 60_000;

async function withinLaunchTimeout<T>(launch: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${LAUNCH_TIMEOUT_MS / 1000} s`)),
      LAUNCH_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([launch, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Give the work up: the kind records it as failed, then the job's row is
 * finished. The kind's own record comes first, so a failure in between
 * leaves a row the next tick gives up again rather than a silent stop.
 */
export async function giveUpReportingJob(
  deps: AdminJobDeps,
  def: ReportingJobKindDef,
  subjectId: string,
  message: string,
): Promise<void> {
  await def.giveUp(deps, subjectId, message);
  await op(deps, "reporting_jobs.finish", {
    kind: def.kind,
    subjectId,
    attempt: null,
    outcome: "given-up",
    note: message.slice(0, 2000),
  });
}

/**
 * Start the next attempt of `kind` on `subjectId`: its first, or — when
 * the last one's lease ran out — the next. Never throws for a launch
 * failure (that is retried); throws only when the database fails.
 *
 * @param opts.launcher - run it here instead (tests drive in-process runs).
 */
export async function startReportingJob(
  deps: AdminJobDeps,
  kind: ReportingJobKind,
  subjectId: string,
  opts: { readonly launcher?: JobLauncher; readonly env?: Record<string, string | undefined> } = {},
): Promise<StartOutcome> {
  const def = reportingJobKind(kind);
  const choice: LauncherChoice = opts.launcher
    ? { kind: "launcher", launcher: opts.launcher }
    : launcherFor(def, opts.env);
  if (choice.kind === "none") return { outcome: "no-launcher" };
  if (choice.kind === "unavailable") {
    await giveUpReportingJob(deps, def, subjectId, choice.message);
    return { outcome: "given-up", message: choice.message };
  }
  const timing = JOB_TIMING[kind];
  const token = mintJobToken();
  const begun = await op<
    | { started: true; attempt: number }
    | {
        started: false;
        reason: "running" | "finished" | "exhausted";
        attempt: number;
        lastError: string | null;
        execution: string | null;
      }
  >(deps, "reporting_jobs.begin_attempt", {
    kind,
    subjectId,
    tokenHash: hashJobToken(token),
    leaseSeconds: timing.firstLeaseSeconds,
    maxAttempts: timing.maxAttempts,
  });
  if (!begun.started) {
    if (begun.reason !== "exhausted") return { outcome: begun.reason };
    const where = begun.execution ? ` (${begun.execution})` : "";
    const message = `the ${def.label}'s job stopped ${begun.attempt} time(s) without finishing; the last attempt${where} ${
      begun.lastError ?? "stopped reporting, and its log says why"
    }`;
    await giveUpReportingJob(deps, def, subjectId, message);
    return { outcome: "given-up", message };
  }
  const order: JobOrder = {
    version: CAELO_VERSION,
    kind,
    subjectId,
    attempt: begun.attempt,
    token,
  };
  try {
    const execution = await withinLaunchTimeout(choice.launcher.launch(order));
    await op(deps, "reporting_jobs.record_launch", {
      kind,
      subjectId,
      attempt: begun.attempt,
      execution: execution.slice(0, 400),
    });
    return { outcome: "started", attempt: begun.attempt, execution };
  } catch (e) {
    const message = `could not be started on ${choice.launcher.label}: ${e instanceof Error ? e.message : String(e)}`;
    await op(deps, "reporting_jobs.release", {
      kind,
      subjectId,
      attempt: begun.attempt,
      reason: message.slice(0, 2000),
    });
    return { outcome: "launch-failed", attempt: begun.attempt, message };
  }
}
