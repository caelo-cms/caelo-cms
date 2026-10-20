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
 * A lock taken by a process outside Cloud Run (a CLI run on someone's
 * machine or in Cloud Shell) names its host and pid and carries a short
 * lease that the holder renews while it runs (the heartbeat in
 * state-store.ts). Such a lock is broken when:
 *
 *   - it was taken on THIS machine and its pid is no longer alive (a
 *     killed CLI on the same machine — no need to wait for the lease). The
 *     machine is told apart by {@link machineId}, not by its host name
 *     alone: every Cloud Run container calls itself the same, and two
 *     laptops may too, so a pid that is dead HERE says nothing about a
 *     process THERE. Inside Cloud Run there is no machine id at all, so a
 *     lock from there is only ever judged by its lease; or
 *   - its lease has expired: the holder stopped renewing it (killed, or a
 *     closed Cloud Shell), so it can no longer be writing.
 *
 * Only a lock written before #815 (no lease, no execution) is never broken
 * automatically; its holder message names the command to remove it.
 *
 * Everything here is pure except {@link describeExecution}, which takes a
 * {@link SyncGcloud}; the lock itself (create, generation-matched break,
 * release) lives in state-store.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
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
 * A lock holder outside Cloud Run (a CLI process): its lease is short and
 * renewed by a heartbeat while it runs, so a holder that dies stops
 * renewing and its lock expires on its own (#815).
 */
export interface ProcessLockHolder {
  readonly leaseMs: number;
}

/** Who takes a lock: a Cloud Run execution, or a renewing process. */
export type LockHolder = ExecutionLockHolder | ProcessLockHolder;

/** The lease of a CLI process's lock; renewed every third of it. */
export const PROCESS_LEASE_MS = 10 * 60_000;

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
  /** Unique per acquisition: proves a lock is still the one this run took. */
  id: z.string().optional(),
  host: z.string().optional(),
  /** {@link machineId} of the writer; null when it has none (Cloud Run). */
  machine: z.string().nullable().optional(),
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
 * @param holder a Cloud Run execution (lease: `now + maxRuntimeMs +
 *   LEASE_SKEW_MS`) or a renewing process (lease: `now + leaseMs +
 *   LEASE_SKEW_MS`); none only for the machine-local lock file, which is
 *   judged by its pid alone
 * @param id the acquisition's id; a fresh one when omitted
 */
export function lockBody(
  purpose: string,
  now: Date,
  holder?: LockHolder,
  id: string = randomUUID(),
): string {
  const leaseMs = holder ? ("execution" in holder ? holder.maxRuntimeMs : holder.leaseMs) : null;
  const body: LockBody = {
    purpose,
    id,
    host: THIS_HOST.host,
    machine: THIS_HOST.machine ?? null,
    pid: process.pid,
    startedAt: now.toISOString(),
    ...(holder && "execution" in holder ? { execution: { ...holder.execution } } : {}),
    ...(leaseMs !== null
      ? { leaseUntil: new Date(now.getTime() + leaseMs + LEASE_SKEW_MS).toISOString() }
      : {}),
  };
  return JSON.stringify(body);
}

/**
 * The same lock body with its lease moved to `now + leaseMs + skew` — the
 * heartbeat of a process holder. Everything else (id, start) is kept.
 */
export function renewedLockBody(body: LockBody, now: Date, leaseMs: number): string {
  return JSON.stringify({
    ...body,
    leaseUntil: new Date(now.getTime() + leaseMs + LEASE_SKEW_MS).toISOString(),
  });
}

/** Whether process `pid` exists on this host (signal 0 checks without signalling). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just someone else's.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An id for this machine AND pid namespace, so a pid is only ever checked
 * where it was taken: the host name, the network cards' MAC addresses and
 * (on Linux) the pid namespace. Null inside Cloud Run, where every
 * container is called `localhost`, has its own pid space and no stable
 * hardware to tell it apart — a lock from there is judged by its lease
 * alone. Null too when the machine shows no network card. An id that
 * changes while a lock is held (a new network card) only makes a later
 * judge wait for the lease: a mismatch is always the safe direction.
 */
export function machineId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUD_RUN_EXECUTION || env.K_SERVICE) return null;
  const macs = new Set<string>();
  for (const cards of Object.values(networkInterfaces())) {
    for (const card of cards ?? []) {
      if (!card.internal && card.mac && card.mac !== "00:00:00:00:00:00") macs.add(card.mac);
    }
  }
  if (macs.size === 0) return null;
  let pidSpace = "";
  try {
    pidSpace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // Not Linux: the machine has one pid space, which the MACs already name.
  }
  return createHash("sha256")
    .update([hostname(), pidSpace, ...[...macs].sort()].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/** The judging run's own host and how it checks a local pid. */
export interface LocalHost {
  readonly host: string;
  /**
   * {@link machineId}; a lock that names another (or none) is never judged
   * by its pid. Left out only by a lock from before the machine id, which
   * falls back to comparing host names (state-lock-lease tests).
   */
  readonly machine?: string | null;
  readonly alive: (pid: number) => boolean;
}

const THIS_HOST: LocalHost = { host: hostname(), machine: machineId(), alive: processAlive };

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
 * @param here this host's name and pid check, for a process holder's lock
 */
export function judgeHeldLock(
  text: string,
  describe: (ref: CloudRunExecutionRef) => ExecutionState,
  now: Date,
  here: LocalHost = THIS_HOST,
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
  if (!body.execution) return judgeProcessLock(body, who, now, here);
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

/**
 * A process holder's lock (a CLI run): broken when its pid is dead on this
 * very host, or once its lease — renewed while the holder runs — expired.
 */
function judgeProcessLock(body: LockBody, who: string, now: Date, here: LocalHost): LockVerdict {
  if (body.pid !== undefined && sameMachine(body, here) && !here.alive(body.pid)) {
    return { kind: "break", why: `${who} has ended (its process is gone on this machine)` };
  }
  if (body.leaseUntil === undefined) {
    // Written before #815: no lease to wait out, and its host may be
    // another machine — only a person may remove it.
    return { kind: "held", why: `held by ${who}`, manualRemoval: true };
  }
  const leaseUntil = Date.parse(body.leaseUntil);
  if (Number.isNaN(leaseUntil)) {
    return {
      kind: "held",
      why: `held by ${who}, whose lock carries no readable lease`,
      manualRemoval: true,
    };
  }
  if (now.getTime() > leaseUntil) {
    return {
      kind: "break",
      why: `${who} stopped renewing its lock; its lease ended at ${body.leaseUntil}`,
    };
  }
  return {
    kind: "held",
    why: `held by ${who}; its lease runs until ${body.leaseUntil} unless renewed`,
    manualRemoval: false,
  };
}

/**
 * Whether the lock was taken where `here` can check its pid. A lock naming
 * a machine id needs this run's to match; one naming none (Cloud Run)
 * never matches; a lock from before machine ids compares host names.
 */
function sameMachine(body: LockBody, here: LocalHost): boolean {
  if (body.host !== here.host) return false;
  // A judge in Cloud Run shares its host name with every other container.
  if (here.machine === null) return false;
  if (body.machine === undefined) return true;
  return body.machine !== null && here.machine != null && body.machine === here.machine;
}

/** "caelo upgrader job (run X, started T)" — for messages. */
function holderText(body: LockBody): string {
  const parts: string[] = [];
  if (body.execution) parts.push(`run ${body.execution.name}`);
  else if (body.host) parts.push(`on ${body.host}${body.pid ? `, pid ${body.pid}` : ""}`);
  if (body.startedAt) parts.push(`started ${body.startedAt}`);
  return parts.length > 0 ? `${body.purpose} (${parts.join(", ")})` : body.purpose;
}
