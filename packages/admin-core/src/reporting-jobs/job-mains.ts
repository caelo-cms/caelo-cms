// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — what each kind of reporting job runs: the job's side, which
 * reads nothing from the database and talks to the admin only through its
 * reporter. Shared by the job container's entry point (job-entry.ts) and
 * the in-process runner of self-hosted and development installs
 * (in-process.ts).
 */

import { runBuildCarrierJob } from "../build-carrier/job.js";
import { runQualityAuditJob } from "../quality/audit-job.js";
import { runSiteImportJob } from "../site-import/crawl-job.js";
import type { ReportingJobKind } from "./protocol.js";
import type { JobMain } from "./run-job.js";

/** The main function of each kind. */
export const JOB_MAINS: Readonly<Record<ReportingJobKind, JobMain>> = {
  quality_audit: (reporter) => runQualityAuditJob(reporter),
  site_import: (reporter) => runSiteImportJob(reporter),
  build: (reporter) => runBuildCarrierJob(reporter),
};
