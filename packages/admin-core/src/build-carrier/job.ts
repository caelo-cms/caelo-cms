// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — the build carrier's job: one report, `run`, which the admin
 * answers when the ordered build ended. The job does nothing else — it
 * builds nothing, reads nothing, fetches nothing; its request is the CPU
 * the admin builds on (kind.ts). Its lease is renewed by the job's
 * heartbeat while the report runs (reporting-jobs/run-job.ts).
 */

import type { JobReporter } from "../reporting-jobs/job-reporter.js";
import type { BuildRunAnswer } from "./order.js";

/** The carrier's main: hold the `run` report until the admin answers. */
export async function runBuildCarrierJob(reporter: JobReporter): Promise<void> {
  const answer = await reporter.call<BuildRunAnswer>("run");
  console.log(`[build-carrier] ${reporter.subjectId}: the build ${answer.outcome}`);
}
