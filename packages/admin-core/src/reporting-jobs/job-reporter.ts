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

  async function send(envelope: ReportEnvelope): Promise<unknown> {
    const deadline = now() + budget;
    let delay = 1000;
    for (;;) {
      if (stopped) throw stopped;
      let status: number;
      let answer: ReportAnswer;
      try {
        ({ status, answer } = await transport.send(envelope));
      } catch (e) {
        if (now() + delay > deadline) {
          throw new ReportError(
            `could not reach the admin through ${transport.label} for ${Math.round(budget / 1000)} s: ${e instanceof Error ? e.message : String(e)}`,
            0,
            "unreachable",
          );
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
        continue;
      }
      if (answer.ok) return answer.value;
      if (status === 409) {
        stopped = new JobStoppedError(answer.error.code, answer.error.message);
        throw stopped;
      }
      if (retryable(status)) {
        const wait =
          answer.retryAfterSeconds !== undefined ? answer.retryAfterSeconds * 1000 : delay;
        if (now() + wait <= deadline) {
          await sleep(wait);
          delay = Math.min(delay * 2, 30_000);
          continue;
        }
      }
      throw new ReportError(
        `the admin refused "${envelope.action}" (HTTP ${status}, ${answer.error.code}): ${answer.error.message}`,
        status,
        answer.error.code,
      );
    }
  }

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
      const uploaded = async (): Promise<T> => {
        const uploadId = randomUUID();
        for (const [part, data] of parts.entries()) {
          await send({ ...base, action: "upload-part", payload: { uploadId, part, data } });
        }
        return (await send({ ...base, action, upload: { uploadId, parts: parts.length } })) as T;
      };
      try {
        return await uploaded();
      } catch (e) {
        // The admin reads an upload once; when the action failed after
        // that (and its retry found the parts gone), send them once more.
        if (e instanceof ReportError && e.code === "incomplete-upload") return uploaded();
        throw e;
      }
    },
  };
}
