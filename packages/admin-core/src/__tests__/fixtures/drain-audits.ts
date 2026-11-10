// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — run every queued quality audit to its end inside a test,
 * the real way: start its job (a lease and a token through
 * `reporting_jobs.begin_attempt`), run the job's main in this process, every
 * report through the admin's `handleJobReport` — exactly what a
 * self-hosted admin does, minus the fire-and-forget. What the in-admin
 * worker's drain did before the audit moved into its job.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { type AuditJobDeps, runQualityAuditJob } from "../../quality/audit-job.js";
import { qualityAuditJobKind } from "../../quality/audit-job-kind.js";
import type { ClaimedAuditRun } from "../../quality/audit-run.js";
import { REPORTING_JOB_CTX } from "../../reporting-jobs/kind.js";
import { runInProcessAttempt } from "../../reporting-jobs/in-process.js";
import { startReportingJob } from "../../reporting-jobs/launcher.js";
import type { JobOrder } from "../../reporting-jobs/protocol.js";

/**
 * Claim the oldest audit that has no job, as its job's `start` report would
 * (`quality_audits.claim`), for a test that records a hand-made result.
 *
 * @returns the claimed run, or null when no audit waits.
 */
export async function claimNextQueuedAudit(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<ClaimedAuditRun | null> {
  const [auditRunId] = await qualityAuditJobKind.listUnstarted(deps, 1);
  if (!auditRunId) return null;
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, "quality_audits.claim", {
    auditRunId,
  });
  if (!r.ok) throw new Error(`quality_audits.claim failed: ${JSON.stringify(r.error)}`);
  return (r.value as { run: ClaimedAuditRun | null }).run;
}

/**
 * Start and finish the job of every audit that has none, oldest first.
 *
 * @returns how many audits ran.
 * @throws when an audit's job did not start or crashed.
 */
export async function drainAuditQueue(
  deps: { readonly adapter: DatabaseAdapter; readonly registry: OperationRegistry } & AuditJobDeps,
): Promise<number> {
  let processed = 0;
  for (;;) {
    const [auditRunId] = await qualityAuditJobKind.listUnstarted(deps, 1);
    if (!auditRunId) return processed;
    const orders: JobOrder[] = [];
    const started = await startReportingJob(deps, "quality_audit", auditRunId, {
      launcher: {
        label: "the test",
        launch: async (order) => {
          orders.push(order);
          return "in-process:test";
        },
      },
    });
    const order = orders[0];
    if (started.outcome !== "started" || !order) {
      throw new Error(`audit ${auditRunId} did not start: ${JSON.stringify(started)}`);
    }
    const outcome = await runInProcessAttempt(deps, order, (reporter) =>
      runQualityAuditJob(reporter, deps),
    );
    if (outcome === "crashed") throw new Error(`audit ${auditRunId}'s job crashed (see the log)`);
    processed += 1;
  }
}
