// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the entry point of a reporting job's container (Google
 * Cloud: one execution of the kind's Cloud Run job, which runs the admin
 * image):
 *
 *   CAELO_REPORTING_JOB_ORDER='<JobOrder JSON>' bun --bun packages/admin-core/src/reporting-jobs/job-entry.ts
 *
 * Least privilege (packages/provisioning/src/reporting-job-setup.ts): the
 * job's identity holds no database credential and no secret. It may sign
 * an IAP credential as itself, which lets it reach the admin, where its
 * reports are admitted only with this attempt's token. What else it may
 * read is its kind's (the quality audit: the staged build, the audit
 * results).
 *
 * Exit 0 when the attempt ended as the admin wanted (its result recorded,
 * or the admin told it to stop, or it deferred to a job on the admin's
 * version); 1 when it died. Cloud Run does not retry it (`--max-retries=0`):
 * the attempt's lease runs out and the scheduler tick's backstop starts
 * the next one.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { httpReportTransport, serviceAccountIapCredential } from "./http-transport.js";
import { JOB_MAINS } from "./job-mains.js";
import { createJobReporter, JobStoppedError, type ReportTransport } from "./job-reporter.js";
import { JOB_ORDER_ENV_VAR, JOB_TIMING, type JobOrder, jobOrderSchema } from "./protocol.js";
import { type JobMain, runJobAttempt } from "./run-job.js";

/**
 * Run one order's attempt over `transport`: defer when this image is on
 * another version than the admin that started it, else the kind's main
 * under a renewed lease.
 *
 * @returns how the attempt ended.
 */
export async function runOrder(
  order: JobOrder,
  transport: ReportTransport,
  opts: { readonly version?: string; readonly main?: JobMain } = {},
): Promise<"completed" | "stopped" | "deferred"> {
  const version = opts.version ?? CAELO_VERSION;
  const reporter = createJobReporter(order, transport);
  if (order.version !== version) {
    // The image did not follow the admin's last upgrade (or rollback) yet;
    // the next attempt starts on the job's image as it is then.
    try {
      await reporter.call("defer", {
        reason: `the job runs Caelo ${version} but the admin runs ${order.version}: its image did not follow the last upgrade — \`cms-provision upgrade\` moves it`,
      });
    } catch (e) {
      if (!(e instanceof JobStoppedError)) throw e;
    }
    return "deferred";
  }
  return runJobAttempt(
    reporter,
    opts.main ?? JOB_MAINS[order.kind],
    JOB_TIMING[order.kind].renewEverySeconds * 1000,
  );
}

/** Run the attempt this container was started for. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const raw = env[JOB_ORDER_ENV_VAR];
  if (!raw) {
    throw new Error(`${JOB_ORDER_ENV_VAR} is not set — the admin passes the job's order in it`);
  }
  const order = jobOrderSchema.parse(JSON.parse(raw));
  if (!order.adminUrl) {
    throw new Error("the order names no admin URL: a job container reports through IAP");
  }
  const outcome = await runOrder(
    order,
    httpReportTransport({
      kind: order.kind,
      adminUrl: order.adminUrl,
      token: order.token,
      credential: serviceAccountIapCredential(order.adminUrl),
    }),
  );
  console.log(
    `[reporting-job] ${order.kind} ${order.subjectId} attempt ${order.attempt}: ${outcome}`,
  );
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error("[reporting-job] failed:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
