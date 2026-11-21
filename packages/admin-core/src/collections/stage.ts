// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R1 #1647, R2 #1648) — what a Stage does for page output and
 * collections once its build is recorded: commit the observers' deliveries,
 * plan the run's collection releases and start the index job; and what it
 * undoes when the build fails.
 *
 * Both steps run after `deploy.finish_trigger`, as the system, in their own
 * transactions. An admin that dies between them leaves deliveries pending
 * (the next Stage sends those pages again) or a run without collection
 * releases (Publish live refuses it and asks for a new Stage): never a run
 * that serves an index it did not build.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";

/** Observers whose page output failed in this Stage, as the build reported them. */
export interface FailedObserver {
  readonly pluginId: string;
  readonly error: string;
}

/** After a successful Stage: commit page output, plan and start the index. Returns a note for the run, or null. */
export async function afterStageBuild(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  runId: string,
  failed: readonly FailedObserver[],
): Promise<string | null> {
  const committed = await execute(deps.registry, deps.adapter, sys, "page_output.commit_run", {
    runId,
  });
  if (!committed.ok)
    return `the page output of this Stage could not be recorded (${describeError(committed.error)}); the next Stage sends those pages again`;
  const planned = await execute(deps.registry, deps.adapter, sys, "collections.plan_run", {
    runId,
    failed: failed.map((f) => ({ pluginId: f.pluginId, error: f.error.slice(0, 2000) })),
  });
  if (!planned.ok)
    return `the search index of this Stage could not be planned (${describeError(planned.error)}); Stage again`;
  const { pending } = planned.value as { pending: number };
  if (pending === 0) return null;
  // Never fails the Stage: the releases are planned, and a start that went
  // wrong is retried by the scheduler tick's backstop (collections.unstarted_runs).
  try {
    const r = await startReportingJob(deps, "collection_index", runId);
    if (r.outcome === "launch-failed" || r.outcome === "given-up")
      console.error(`[collections] run ${runId}: ${r.outcome}: ${r.message}`);
  } catch (e) {
    console.error(
      `[collections] run ${runId}: the index job did not start (the next scheduler tick starts it):`,
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

/** After a failed Stage: its page output never happened. */
export async function afterFailedStage(
  deps: AdminJobDeps,
  sys: ExecutionContext,
  runId: string,
): Promise<void> {
  const r = await execute(deps.registry, deps.adapter, sys, "page_output.discard_run", { runId });
  if (!r.ok)
    console.error("[deploy] could not discard the failed Stage's page output", {
      runId,
      error: describeError(r.error),
    });
}
