// SPDX-License-Identifier: MPL-2.0

/**
 * The lease on the install's bucket state lock (#815): who holds it, and
 * whether a later run may break it.
 *
 * A lock written by a Cloud Run job execution (the upgrader job, later the
 * converge job #819) names that execution and a lease: the execution's
 * start plus its task timeout, after which Cloud Run has killed it for
 * sure. A run that finds the lock held asks Cloud Run about the holder:
 *
 *   - the execution has finished (succeeded, failed, cancelled): it can no
 *     longer write, so its lock is dead and may be broken;
 *   - it is still running: the lock is live and is NEVER broken — not even
 *     past its lease (a lease is our estimate; Cloud Run's state is fact);
 *   - Cloud Run does not know it (deleted, or a name we cannot resolve):
 *     broken only once the lease has expired, when no execution of that
 *     job can still be alive;
 *   - Cloud Run cannot be asked (no access, gcloud error): not decided
 *     here — the caller reports the error; guessing "dead" could let two
 *     runs write the same state.
 *
 * A lock without an execution (a CLI run on someone's machine, or a lock
 * written before #815) cannot be checked from the cloud, so it is never
 * broken automatically; its holder message names the command to remove it.
 *
 * Everything here is pure except {@link describeExecution}, which takes a
 * {@link SyncGcloud}; the lock itself (create, generation-matched break,
 * release) lives in state-store.ts.
 */

import { hostname } from "node:os";
import { z } from "zod";
import type { GcloudResult } from "./gcloud.js";

/** A Cloud Run job execution, fully addressed. */
export interface CloudRunExecutionRef {
  readonly projectId: string;
  readonly region: string;
  /** The execution's short name (`CLOUD_RUN_EXECUTION`). */
  readonly name: string;
}

/**
 * A lock holder that Cloud Run can vouch for: the execution and the
 * longest it can run (its task timeout).
 */
export interface ExecutionLockHolder {
  readonly execution: CloudRunExecutionRef;
  readonly maxRuntimeMs: number;
}

/**
 * Margin added to a lease for clock skew between the holder and the run
 * judging it (both read their own clock; Cloud Run's are NTP-synced, a
 * developer laptop's may not be).
 */
export const LEASE_SKEW_MS = 5 * 60_000;

const executionRefSchema = z.object({
  projectId: z.string().min(1),
  region: z.string().min(1),
  name: z.string().min(1),
});

/** The lock object's body. `execution` + `leaseUntil` appear together (#815). */
const lockBodySchema = z.object({
  purpose: z.string(),
  host: z.string().optional(),
  pid: z.number().optional(),
  startedAt: z.string().optional(),
  execution: executionRefSchema.optional(),
  leaseUntil: z.string().optional(),
});

/** The lock body as written by {@link lockBody}. */
export type LockBody = z.infer<typeof lockBodySchema>;

/**
 * The body a new lock is written with.
 *
 * @param holder present when a Cloud Run execution takes the lock; its
 *   lease is `now + maxRuntimeMs + LEASE_SKEW_MS`
 */
export function lockBody(purpose: string, now: Date, holder?: ExecutionLockHolder): string {
  const body: LockBody = {
    purpose,
    host: hostname(),
    pid: process.pid,
    startedAt: now.toISOString(),
    ...(holder
      ? {
          execution: { ...holder.execution },
          leaseUntil: new Date(now.getTime() + holder.maxRuntimeMs + LEASE_SKEW_MS).toISOString(),
        }
      : {}),
  };
  return JSON.stringify(body);
}

/** Parse a lock body; null when it is not one this code wrote. */
export function parseLockBody(text: string): LockBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = lockBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What Cloud Run says about the holder's execution. */
export type ExecutionState =
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly how: string }
  | { readonly kind: "not-found" }
  /** Cloud Run could not be asked; `error` says why. */
  | { readonly kind: "unknown"; readonly error: string };

const NOT_FOUND = /NOT_FOUND|not found|could not be found|does not exist/i;

const executionStatusSchema = z.object({
  status: z
    .object({
      completionTime: z.string().optional(),
      conditions: z
        .array(
          z.object({
            type: z.string(),
            status: z.string(),
            reason: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/**
 * Read an execution's state from `gcloud run jobs executions describe
 * --format=json`. An execution has finished once Cloud Run stamped its
 * completion time or decided its `Completed` condition (True: succeeded;
 * False: failed or cancelled). Anything else is still running — including
 * an execution Cloud Run has not started yet.
 */
export function parseExecutionState(result: GcloudResult): ExecutionState {
  if (!result.ok) {
    if (NOT_FOUND.test(result.stderr)) return { kind: "not-found" };
    return {
      kind: "unknown",
      error: result.stderr.trim() || `gcloud exited ${result.exitCode}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return { kind: "unknown", error: "gcloud returned no JSON for the execution" };
  }
  const parsed = executionStatusSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "unknown", error: "gcloud returned an execution without a readable status" };
  }
  const status = parsed.data.status;
  const completed = status?.conditions?.find((c) => c.type === "Completed");
  if (completed && (completed.status === "True" || completed.status === "False")) {
    const how =
      completed.status === "True" ? "succeeded" : (completed.reason ?? "failed").toLowerCase();
    return { kind: "finished", how };
  }
  if (status?.completionTime) return { kind: "finished", how: "completed" };
  return { kind: "running" };
}

/** `gcloud run jobs executions describe`, for {@link judgeHeldLock}. */
export function describeExecutionArgs(ref: CloudRunExecutionRef): string[] {
  return [
    "run",
    "jobs",
    "executions",
    "describe",
    ref.name,
    `--region=${ref.region}`,
    `--project=${ref.projectId}`,
    "--format=json",
  ];
}

/** Whether a held lock may be broken, and the words for either outcome. */
export type LockVerdict =
  | { readonly kind: "break"; readonly why: string }
  | { readonly kind: "held"; readonly why: string; readonly manualRemoval: boolean }
  /** The holder could not be checked; never treated as "dead". */
  | { readonly kind: "unknown"; readonly why: string };

/**
 * Decide whether the lock with body `text` may be broken.
 *
 * @param describe looks the holder's execution up in Cloud Run; called only
 *   when the body names one
 * @param now the judging run's clock, compared against the lease
 */
export function judgeHeldLock(
  text: string,
  describe: (ref: CloudRunExecutionRef) => ExecutionState,
  now: Date,
): LockVerdict {
  const body = parseLockBody(text);
  if (!body) {
    return {
      kind: "held",
      why: `the lock's holder is not readable (${text.trim().slice(0, 200) || "empty"})`,
      manualRemoval: true,
    };
  }
  const who = holderText(body);
  if (!body.execution) {
    // A CLI run or a pre-#815 lock: nothing in the cloud can vouch that it
    // has ended, so only a person may remove it.
    return { kind: "held", why: `held by ${who}`, manualRemoval: true };
  }
  const leaseUntil = body.leaseUntil ? Date.parse(body.leaseUntil) : Number.NaN;
  const state = describe(body.execution);
  switch (state.kind) {
    case "finished":
      return {
        kind: "break",
        why: `${who} has ${state.how}, but its lock was left behind`,
      };
    case "running":
      return { kind: "held", why: `${who} is still running`, manualRemoval: false };
    case "not-found":
      if (Number.isNaN(leaseUntil)) {
        return {
          kind: "held",
          why: `${who} is unknown to Cloud Run and its lock carries no readable lease`,
          manualRemoval: true,
        };
      }
      if (now.getTime() > leaseUntil) {
        return {
          kind: "break",
          why: `${who} is unknown to Cloud Run and its lease ended at ${body.leaseUntil}`,
        };
      }
      return {
        kind: "held",
        why: `${who} is unknown to Cloud Run, but its lease runs until ${body.leaseUntil}`,
        manualRemoval: false,
      };
    case "unknown":
      return {
        kind: "unknown",
        why: `could not check whether ${who} is still running: ${state.error}`,
      };
  }
}

/** "caelo upgrader job (run X, started T)" — for messages. */
function holderText(body: LockBody): string {
  const parts: string[] = [];
  if (body.execution) parts.push(`run ${body.execution.name}`);
  else if (body.host) parts.push(`on ${body.host}${body.pid ? `, pid ${body.pid}` : ""}`);
  if (body.startedAt) parts.push(`started ${body.startedAt}`);
  return parts.length > 0 ? `${body.purpose} (${parts.join(", ")})` : body.purpose;
}
