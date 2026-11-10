// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the scheduler tick's backstop for reporting jobs (the core
 * task `core:reporting-jobs`, every tick). A job that dies stops reporting;
 * nothing else would notice. Per kind the backstop:
 *
 *   1. starts the next attempt of every job whose lease ran out — or, after
 *      the kind's last attempt, gives the work up with the reason
 *      (launcher.ts `startReportingJob`);
 *   2. starts a job for work that has none (the Stage request that should
 *      have started it died, or a release before reporting jobs queued it)
 *      — or gives it up, for a kind whose work must not start late (a
 *      build a person asked for: kind.ts `unstarted`).
 *
 * A tick runs it inside a request, so the admin has the CPU for it on a
 * request-billed instance (CLAUDE.md §11.B Tier 5). It never builds or
 * publishes anything (scripts/no-automatic-production-deploy.test.ts).
 */

import { execute } from "@caelo-cms/query-api";
import { describeError } from "../ai/tools/_describe-error.js";
import { type AdminJobDeps, REPORTING_JOB_CTX } from "./kind.js";
import { reportingJobKinds } from "./kinds.js";
import {
  giveUpReportingJob,
  type JobLauncher,
  launcherFor,
  type StartOutcome,
  startReportingJob,
} from "./launcher.js";

/** Most expired jobs and most unstarted pieces of work one tick handles per kind. */
const PER_TICK = 20;

/** Finished rows are kept this long for diagnosis, then swept. */
export const REPORTING_JOB_RETENTION_DAYS = 7;

/**
 * Run the backstop once. Resolves with a one-line summary, or undefined
 * when there was nothing to do.
 *
 * @param opts.launcher - start attempts here (tests); the install's otherwise.
 */
export async function runReportingJobBackstop(
  deps: AdminJobDeps,
  opts: { readonly launcher?: JobLauncher; readonly env?: Record<string, string | undefined> } = {},
): Promise<string | undefined> {
  const parts: string[] = [];
  for (const def of reportingJobKinds()) {
    // Nothing in this process could run them (a test, a script): leave the
    // work for whoever drives it rather than giving it up.
    if (!opts.launcher && launcherFor(def, opts.env).kind === "none") continue;
    const counts = new Map<StartOutcome["outcome"], number>();
    const start = async (subjectId: string) => {
      const r = await startReportingJob(deps, def.kind, subjectId, opts);
      counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
    };
    const expired = await execute(
      deps.registry,
      deps.adapter,
      REPORTING_JOB_CTX,
      "reporting_jobs.list_expired",
      { kind: def.kind, limit: PER_TICK },
    );
    if (!expired.ok) {
      throw new Error(`reporting_jobs.list_expired failed: ${describeError(expired.error)}`);
    }
    for (const job of (expired.value as { jobs: { subjectId: string }[] }).jobs) {
      await start(job.subjectId);
    }
    for (const subjectId of await def.listUnstarted(deps, PER_TICK)) {
      if (def.unstarted === "start") {
        await start(subjectId);
        continue;
      }
      await giveUpReportingJob(
        deps,
        def,
        subjectId,
        `its job was never started: the request that asked for the ${def.label} ended before it could start one`,
      );
      counts.set("given-up", (counts.get("given-up") ?? 0) + 1);
    }
    if (counts.size > 0) {
      parts.push(
        `${def.kind}: ${[...counts.entries()].map(([outcome, n]) => `${n} ${outcome}`).join(", ")}`,
      );
    }
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Drop finished job rows past their retention (the daily clean-up task). */
export async function sweepFinishedReportingJobs(deps: AdminJobDeps): Promise<number> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, "reporting_jobs.sweep", {
    olderThanDays: REPORTING_JOB_RETENTION_DAYS,
    limit: 1000,
  });
  if (!r.ok) throw new Error(`reporting_jobs.sweep failed: ${describeError(r.error)}`);
  return (r.value as { deleted: number }).deleted;
}
