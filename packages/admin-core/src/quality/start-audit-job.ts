// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — start the job of a freshly queued quality audit: right
 * after the Stage recorded its build (deploy.trigger), and after a retry
 * queued one (`quality_audits.retry`). Inside that request, so the audit
 * starts without waiting for a tick and the request's CPU pays for the
 * start. The audit itself runs in its job (quality/audit-job.ts).
 *
 * Never fails its caller: the audit row is already committed, and a start
 * that went wrong here is retried by the scheduler tick's backstop, which
 * finds every queued audit without a job (`quality_audits.sweep_unstarted`).
 */

import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";

/** Start the job of queued audit `auditRunId`; logs what went wrong instead of throwing. */
export async function startQualityAuditJob(deps: AdminJobDeps, auditRunId: string): Promise<void> {
  try {
    const r = await startReportingJob(deps, "quality_audit", auditRunId);
    if (r.outcome === "launch-failed" || r.outcome === "given-up") {
      console.error(`[quality-audit] audit ${auditRunId}: ${r.outcome}: ${r.message}`);
    }
  } catch (e) {
    console.error(
      `[quality-audit] audit ${auditRunId}: its job did not start (the next scheduler tick starts it):`,
      e instanceof Error ? e.message : e,
    );
  }
}
