// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the job's side of reporting: send one action to the admin
 * and return its answer. An input too long for one report goes in parts
 * first (`upload-part`), and the action then names the upload. Transient
 * failures (the admin cold-starting, 429, 5xx, a dropped connection) are
 * retried within a budget; a `409` means the admin ended this attempt — a
 * newer one replaced it, or the work is over — and every later call throws
 * {@link JobStoppedError} so the job stops without doing more.
 *
 * Transport-agnostic: in a job container it posts through IAP
 * (http-transport.ts); inside the admin (self-hosted, development) it calls
 * the admin's handler directly (in-process.ts).
 */

import { randomUUID } from "node:crypto";
import {
  INLINE_PAYLOAD_CHARS,
  type JobOrder,
  MAX_UPLOAD_PARTS,
  type ReportAnswer,
  type ReportEnvelope,
  splitIntoParts,
} from "./protocol.js";

/** Carries one report to the admin. A network failure throws. */
export interface ReportTransport {
  readonly label: string;
  send(
    envelope: ReportEnvelope,
  ): Promise<{ readonly status: number; readonly answer: ReportAnswer }>;
}

/** The admin ended this attempt; the job stops. */
export class JobStoppedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobStoppedError";
  }
}

/** The admin refused a report for good, or could not be reached in time. */
export class ReportError extends Error {
  constructor(
    message: string,
    /** The HTTP status; 0 when the admin was not reached. */
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ReportError";
  }
}

/**
 * A failure another attempt may not meet: the admin was not reached within
 * the retry budget, or answered busy (429) or failing (5xx). A job gives
 * such an attempt back (`defer`) and the backstop starts the next one; it
 * never records the work as failed because of it.
 */
export function isPassingReportFault(e: unknown): boolean {
  return e instanceof ReportError && (e.status === 0 || e.status === 429 || e.status >= 500);
}

/** Sends a job's reports. */
export interface JobReporter {
  readonly kind: JobOrder["kind"];
  readonly subjectId: string;
  readonly attempt: number;
  /**
   * Ask the admin to run `action` with `payload`; resolves with its answer.
   *
   * @throws JobStoppedError when the admin ended this attempt.
   * @throws ReportError when it refused the report or stayed unreachable.
   */
  call<T = unknown>(action: string, payload?: unknown): Promise<T>;
  /** True once the admin ended this attempt. */
  readonly stopped: boolean;
}

/**
 * `inner`, remembering the first passing fault of any of its calls, also
 * of a call whose error its caller swallowed (a findings check turns a
 * failed read into a check error, the crawler a failed render into a
 * static fetch), and knowing which calls are still in flight: a call its
 * caller stopped waiting for (a check that timed out) is still running.
 * The job then gives the attempt back instead of recording what the fault,
 * or the race with the admin, spoiled.
 */
export function faultWatchingReporter(inner: JobReporter): {
  readonly reporter: JobReporter;
  fault(): unknown;
  /** The actions of the calls not ended yet. */
  inFlight(): string[];
  /** Resolves once every call made so far has ended, either way. */
  settled(): Promise<void>;
} {
  let fault: unknown = null;
  const running = new Map<Promise<unknown>, string>();
  return {
    reporter: {
      kind: inner.kind,
      subjectId: inner.subjectId,
      attempt: inner.attempt,
      get stopped() {
        return inner.stopped;
      },
      call<T>(action: string, payload?: unknown): Promise<T> {
        const call = inner.call<T>(action, payload).catch((e: unknown) => {
          if (fault === null && isPassingReportFault(e)) fault = e;
          throw e;
        });
        const tracked = call.finally(() => running.delete(tracked)).catch(() => undefined);
        running.set(tracked, action);
        return call;
      },
    },
    fault: () => fault,
    inFlight: () => [...running.values()],
    settled: async () => {
      await Promise.all([...running.keys()]);
    },
  };
}

/** The attempt gave itself back (`defer`): the next tick starts the next one. */
export class AttemptDeferredError extends Error {
  constructor(readonly reason: string) {
    super(`the attempt was given back: ${reason}`);
    this.name = "AttemptDeferredError";
  }
}

/**
 * Give the attempt back with `reason` and end it. When even the report
 * fails, the lease runs out and the backstop starts the next attempt
 * anyway; the reason is then in the job's log only.
 */
export async function deferAttempt(reporter: JobReporter, reason: string): Promise<never> {
  const text = reason.slice(0, 1000) || "the attempt could not go on";
  await reporter.call("defer", { reason: text }).catch(() => undefined);
  throw new AttemptDeferredError(text);
}

export interface ReporterOptions {
  /** How long one report may be retried before it fails (default 3 minutes). */
  readonly retryBudgetMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Statuses worth sending again: the admin was busy, starting or briefly broken. */
function retryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 500;
}

/** One send of a report: its answer, or why not and whether to send it again. */
type SendOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: ReportError;
      readonly retry: boolean;
      /** How long the admin asked to wait (429's Retry-After). */
      readonly waitMs?: number;
    };

/** A reporter for one attempt over `transport`. */
export function createJobReporter(
  order: JobOrder,
  transport: ReportTransport,
  options: ReporterOptions = {},
): JobReporter {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const budget = options.retryBudgetMs ?? 3 * 60_000;
  let stopped: JobStoppedError | null = null;

  async function sendOnce(envelope: ReportEnvelope): Promise<SendOutcome> {
    if (stopped) throw stopped;
    let status: number;
    let answer: ReportAnswer;
    try {
      ({ status, answer } = await transport.send(envelope));
    } catch (e) {
      return {
        ok: false,
        retry: true,
        error: new ReportError(
          `could not reach the admin through ${transport.label} for ${Math.round(budget / 1000)} s: ${e instanceof Error ? e.message : String(e)}`,
          0,
          "unreachable",
        ),
      };
    }
    if (answer.ok) return { ok: true, value: answer.value };
    if (status === 409) {
      stopped = new JobStoppedError(answer.error.code, answer.error.message);
      throw stopped;
    }
    return {
      ok: false,
      retry: retryable(status),
      ...(answer.retryAfterSeconds !== undefined
        ? { waitMs: answer.retryAfterSeconds * 1000 }
        : {}),
      error: new ReportError(
        `the admin refused "${envelope.action}" (HTTP ${status}, ${answer.error.code}): ${answer.error.message}`,
        status,
        answer.error.code,
      ),
    };
  }

  /**
   * Runs `sendIt` again while it fails in a way worth retrying, for at most
   * the retry budget, then fails with its last failure: a passing fault
   * stays one.
   */
  async function retried(sendIt: () => Promise<SendOutcome>): Promise<unknown> {
    const deadline = now() + budget;
    let delay = 1000;
    for (;;) {
      const outcome = await sendIt();
      if (outcome.ok) return outcome.value;
      const wait = outcome.waitMs ?? delay;
      if (!outcome.retry || now() + wait > deadline) throw outcome.error;
      await sleep(wait);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  const send = (envelope: ReportEnvelope): Promise<unknown> => retried(() => sendOnce(envelope));

  const base = { subjectId: order.subjectId, attempt: order.attempt };
  return {
    kind: order.kind,
    subjectId: order.subjectId,
    attempt: order.attempt,
    get stopped() {
      return stopped !== null;
    },
    async call<T>(action: string, payload: unknown = {}): Promise<T> {
      const text = JSON.stringify(payload);
      if (text.length <= INLINE_PAYLOAD_CHARS) {
        return (await send({ ...base, action, payload })) as T;
      }
      const parts = splitIntoParts(text);
      if (parts.length > MAX_UPLOAD_PARTS) {
        throw new ReportError(
          `"${action}" carries ${text.length} characters, more than ${MAX_UPLOAD_PARTS} parts hold`,
          413,
          "too-large",
        );
      }
      // One upload id for the call: a part sent again replaces itself, so a
      // retry never adds to what the run holds.
      const uploadId = randomUUID();
      const envelope: ReportEnvelope = {
        ...base,
        action,
        upload: { uploadId, parts: parts.length },
      };
      const sendParts = async (): Promise<void> => {
        for (const [part, data] of parts.entries()) {
          await send({ ...base, action: "upload-part", payload: { uploadId, part, data } });
        }
      };
      await sendParts();
      // The admin reads an upload once, also when the action then fails or
      // its answer is lost. A retry that finds the parts gone sends them
      // again and the action after them, as often as the retry budget
      // allows, so the failure the budget ends on is the action's own: a
      // passing fault stays one (#1359).
      return (await retried(async () => {
        const outcome = await sendOnce(envelope);
        if (outcome.ok || outcome.error.code !== "incomplete-upload") return outcome;
        await sendParts();
        const again = await sendOnce(envelope);
        // Gone right after they were sent (a request delivered twice): worth
        // another try within the budget, not a verdict.
        return !again.ok && again.error.code === "incomplete-upload"
          ? { ...again, retry: true }
          : again;
      })) as T;
    },
  };
}
