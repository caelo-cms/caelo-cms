// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1360 — start the job of a site import whose crawl may begin: right
 * after the Owner started it (`imports.create_run`) or approved the AI's
 * proposal (`imports.execute_proposal`). Inside that request, so the crawl
 * starts without waiting for a tick and the request's CPU pays for the
 * start. The crawl itself runs in its job (site-import/crawl-job.ts).
 *
 * Never fails its caller: the run is already committed as 'crawling', and a
 * start that went wrong here is retried by the scheduler tick's backstop,
 * which finds every crawling run without a job
 * (`imports.sweep_unstarted_crawls`).
 */

import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";

/** Start the crawl of import run `runId`; logs what went wrong instead of throwing. */
export async function startSiteImportJob(deps: AdminJobDeps, runId: string): Promise<void> {
  try {
    const r = await startReportingJob(deps, "site_import", runId);
    if (r.outcome === "launch-failed" || r.outcome === "given-up") {
      console.error(`[site-import] run ${runId}: ${r.outcome}: ${r.message}`);
    }
  } catch (e) {
    console.error(
      `[site-import] run ${runId}: its crawl's job did not start (the next scheduler tick starts it):`,
      e instanceof Error ? e.message : e,
    );
  }
}
