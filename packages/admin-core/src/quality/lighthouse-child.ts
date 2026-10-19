// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the Lighthouse audit child process. Spawned by
 * `lighthouse-runner.ts` with the same Bun runtime the admin runs on:
 *
 *   bun packages/admin-core/src/quality/lighthouse-child.ts < job.json
 *
 * Why a child process and not in-process (spike result, recorded on the
 * PR): Lighthouse 13 runs fine under Bun, but trace processing is
 * synchronous CPU work that stalled the admin's event loop for ~270 ms on a
 * trivial page (worse on real ones), it adds a few hundred MB of heap, and
 * a crash would take the editor's server down with it. In a child the
 * admin stays responsive, the memory is returned when the audit ends, and
 * the parent can kill a hung audit and report it.
 *
 * One Lighthouse session per audit (lighthouse-session.ts: the bundled
 * Chromium, calibrated to this host), closed before the process exits.
 * Each run is reduced where it ran and the page's runs are combined with
 * `combineRuns`, the same path the parallel audit tasks take (#875).
 */

import { combineRuns, LighthouseRunError, type RunMeasurement } from "./lighthouse-extract.js";
import {
  type AuditJob,
  auditJobSchema,
  type ChildEvent,
  wirePageMeasurement,
} from "./lighthouse-protocol.js";
import { startLighthouseSession } from "./lighthouse-session.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readJob(): Promise<AuditJob> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return auditJobSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function main(): Promise<void> {
  const job = await readJob();
  const started = await startLighthouseSession();
  if (!started.ok) {
    emit({ kind: "fatal", code: started.code, message: started.message });
    return;
  }
  const { session } = started;
  try {
    for (const page of job.pages) {
      try {
        const runs: RunMeasurement[] = [await session.run(page.url, QUALITY_CATEGORIES)];
        for (let i = 1; i < job.performanceRuns; i += 1) {
          runs.push(await session.run(page.url, ["performance"]));
        }
        const { measurement, performanceRuns } = combineRuns(runs);
        const finalUrl = runs[0]?.finalUrl;
        emit({
          kind: "page",
          pageId: page.pageId,
          url: page.url,
          ...(finalUrl ? { finalUrl } : {}),
          measurement: wirePageMeasurement(measurement),
          performanceRuns,
        });
      } catch (e) {
        emit({
          kind: "page-error",
          pageId: page.pageId,
          url: page.url,
          code: e instanceof LighthouseRunError ? e.code : "LIGHTHOUSE_FAILED",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    await session.close();
  }
  emit({ kind: "done" });
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    emit({
      kind: "fatal",
      code: "child-crashed",
      message: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  },
);
