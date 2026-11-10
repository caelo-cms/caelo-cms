// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — reporting jobs inside the admin's own process, for
 * self-hosted and development installs: no extra machines, and an admin
 * there keeps its CPU between requests. The job main is the same one a job
 * container runs; its reports reach the admin's handler directly, as text,
 * so they pass the same caps, the same token check and the same schemas as
 * a report that came through IAP.
 *
 * Started by the Stage request (fire and forget) and by the tick's
 * backstop, which also restarts one whose process died: the lease does not
 * care where the attempt ran.
 */

import { hostname } from "node:os";
import { handleJobReport } from "./dispatch.js";
import { createLines } from "./in-line.js";
import { JOB_MAINS } from "./job-mains.js";
import { createJobReporter, type ReportTransport } from "./job-reporter.js";
import type { AdminJobDeps } from "./kind.js";
import type { JobLauncher } from "./launcher.js";
import { JOB_TIMING, type JobOrder, type ReportingJobKind } from "./protocol.js";
import { type JobMain, runJobAttempt } from "./run-job.js";

/** The transport of a job that runs inside the admin. */
export function inProcessReportTransport(deps: AdminJobDeps, order: JobOrder): ReportTransport {
  return {
    label: "the admin process",
    async send(envelope) {
      const { status, answer } = await handleJobReport(deps, {
        kind: order.kind,
        token: order.token,
        bodyText: JSON.stringify(envelope),
      });
      // What a job behind HTTP would read: plain JSON.
      return { status, answer: JSON.parse(JSON.stringify(answer)) };
    },
  };
}

/**
 * Run one attempt inside this process and wait for it. A crash is logged:
 * the attempt's lease then runs out and the backstop starts the next one,
 * as for a job container that died.
 */
export async function runInProcessAttempt(
  deps: AdminJobDeps,
  order: JobOrder,
  main: JobMain = JOB_MAINS[order.kind],
): Promise<"completed" | "stopped" | "deferred" | "crashed"> {
  const reporter = createJobReporter(order, inProcessReportTransport(deps, order));
  try {
    return await runJobAttempt(reporter, main, JOB_TIMING[order.kind].renewEverySeconds * 1000);
  } catch (e) {
    console.error(
      `[reporting-job] ${order.kind} ${order.subjectId} attempt ${order.attempt} crashed:`,
      e instanceof Error ? (e.stack ?? e.message) : e,
    );
    return "crashed";
  }
}

/**
 * One attempt of a kind at a time in this process (in-line.ts says why).
 * An attempt in line keeps renewing its lease (its heartbeat already runs),
 * so waiting never reads as a dead job.
 */
const inLine = createLines<ReportingJobKind>();

/** A launcher that runs each attempt in this process, in line, without waiting for it. */
export function inProcessJobLauncher(deps: AdminJobDeps, kind: ReportingJobKind): JobLauncher {
  return {
    label: "the admin process",
    async launch(order) {
      if (order.kind !== kind)
        throw new Error(`a ${kind} launcher was handed a ${order.kind} order`);
      void runInProcessAttempt(deps, order, (reporter) =>
        inLine(kind, () => JOB_MAINS[kind](reporter)),
      );
      return `in-process:${process.env.K_REVISION ?? hostname()}/${process.pid}`;
    },
  };
}
