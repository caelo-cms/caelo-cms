// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — run one attempt of a reporting job: the kind's main
 * function under a lease that a heartbeat renews while the main works. The
 * same function runs in a job container (job-entry.ts) and inside the
 * admin on self-hosted and development installs (in-process.ts), so both
 * report through the same calls.
 *
 * The renewal timer is the one interval a job keeps: it lives exactly as
 * long as the attempt and is cleared when the main returns
 * (scripts/no-background-timers.test.ts lists it as such).
 */

import { AttemptDeferredError, type JobReporter, JobStoppedError } from "./job-reporter.js";

/** What a kind's job does with its reporter. */
export type JobMain = (reporter: JobReporter) => Promise<void>;

/**
 * Run `main` while renewing the lease every `renewEveryMs`.
 *
 * @returns `completed` when the main returned, `stopped` when the admin
 *   ended the attempt (a newer one replaced it, or the work is over),
 *   `deferred` when the main gave the attempt back (`deferAttempt`).
 * @throws whatever else the main threw: the attempt died without finishing,
 *   and the backstop starts the next one when its lease runs out.
 */
export async function runJobAttempt(
  reporter: JobReporter,
  main: JobMain,
  renewEveryMs: number,
): Promise<"completed" | "stopped" | "deferred"> {
  const renew = setInterval(() => {
    if (reporter.stopped) return;
    reporter.call("heartbeat").catch((e: unknown) => {
      // A stop shows on the main's next report; anything else is retried
      // by the next beat, and a lease that lapses restarts the attempt.
      if (!(e instanceof JobStoppedError)) {
        console.error(
          `[reporting-job] ${reporter.kind} ${reporter.subjectId}: heartbeat failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    });
  }, renewEveryMs);
  try {
    await main(reporter);
    return "completed";
  } catch (e) {
    if (e instanceof JobStoppedError) return "stopped";
    if (e instanceof AttemptDeferredError) return "deferred";
    throw e;
  } finally {
    clearInterval(renew);
  }
}
