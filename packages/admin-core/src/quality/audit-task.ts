// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — one parallel audit task: one Lighthouse run of one page, in
 * its own short-lived container (Cloud Run job / Fargate task / Container
 * Apps job), started by the admin's parallel runner (`parallel-runner.ts`).
 *
 *   CAELO_AUDIT_TASK='<AuditTaskOrder JSON>' bun packages/admin-core/src/quality/audit-task.ts
 *
 * Least privilege: the task's identity can read the staged build and write
 * into the audit results store, nothing else — no database, no secrets, no
 * provider keys. The order comes from the admin; the task trusts nothing
 * else and validates it.
 *
 * Exit code 0 means a result was written (a page Lighthouse could not
 * measure is a written `run-error`, not a crash). Any other exit leaves no
 * result, and the runner reports the task as failed with a pointer to its
 * log.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { auditResultStoreFromEnv } from "./audit-results-store.js";
import {
  AUDIT_TASK_ENV_VAR,
  type AuditTaskBatch,
  type AuditTaskOrder,
  type AuditTaskResult,
  auditTaskBatchSchema,
  TASK_INDEX_ENV_VAR,
} from "./audit-task-protocol.js";
import { LighthouseRunError, type RunMeasurement } from "./lighthouse-extract.js";
import { startLighthouseSession } from "./lighthouse-session.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";
import { gcsStagingSource, serveStagedBuild } from "./staged-origin.js";

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Re-address every occurrence of one origin in a result (page URL, final
 * URL, flagged resource URLs) to another. The admin reads the result on
 * the origin it addressed the page on, so a task that served the build on
 * its own loopback port reports as if it had used the admin's.
 */
export function readdress(result: AuditTaskResult, from: string, to: string): AuditTaskResult {
  const a = trimTrailingSlash(from);
  const b = trimTrailingSlash(to);
  if (a === b) return result;
  return JSON.parse(JSON.stringify(result).split(a).join(b)) as AuditTaskResult;
}

async function measure(order: AuditTaskOrder): Promise<AuditTaskResult> {
  let url = order.url;
  let close: (() => Promise<void>) | undefined;
  let taskBase: string | null = null;
  if (order.stagedBuild) {
    const origin = await serveStagedBuild(gcsStagingSource(order.stagedBuild.runId), {
      apiOrigin: order.stagedBuild.apiOrigin,
    });
    close = origin.close;
    taskBase = origin.baseUrl;
    const base = trimTrailingSlash(order.stagedBuild.baseUrl);
    if (url !== base && !url.startsWith(`${base}/`)) {
      await close();
      throw new Error(`order url ${url} is not on the staged build's origin ${base}`);
    }
    url = `${trimTrailingSlash(taskBase)}${url.slice(base.length)}`;
  }
  let result: AuditTaskResult;
  try {
    result = await runOnce(order.taskId, url, order.categories);
  } finally {
    await close?.();
  }
  return taskBase && order.stagedBuild
    ? readdress(result, taskBase, order.stagedBuild.baseUrl)
    : result;
}

async function runOnce(
  taskId: string,
  url: string,
  categories: AuditTaskOrder["categories"],
): Promise<AuditTaskResult> {
  const started = await startLighthouseSession();
  if (!started.ok) return { kind: "fatal", taskId, code: started.code, message: started.message };
  try {
    const run = await started.session.run(
      url,
      categories === "all" ? QUALITY_CATEGORIES : ["performance"],
    );
    return { kind: "run", taskId, run: wireRun(run) };
  } catch (e) {
    return {
      kind: "run-error",
      taskId,
      code: e instanceof LighthouseRunError ? e.code : "LIGHTHOUSE_FAILED",
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await started.session.close();
  }
}

/** A reduced run in the wire shape (the schema's mutable arrays). */
function wireRun(run: RunMeasurement): Extract<AuditTaskResult, { kind: "run" }>["run"] {
  return JSON.parse(JSON.stringify(run)) as Extract<AuditTaskResult, { kind: "run" }>["run"];
}

/**
 * This task's order from the batch, or why there is none. Pure; exported
 * for tests.
 *
 * @param index - `CLOUD_RUN_TASK_INDEX`; absent on providers that start one
 *   task per order (a batch of one).
 */
export function pickOrder(
  batch: AuditTaskBatch,
  index: string | undefined,
  ownVersion: string,
): { order: AuditTaskOrder; versionMismatch: string | null } {
  const i = index === undefined ? 0 : Number(index);
  const order = Number.isInteger(i) ? batch.orders[i] : undefined;
  if (!order) {
    throw new Error(
      `task index ${index ?? "(none)"} has no order in a batch of ${batch.orders.length}`,
    );
  }
  return {
    order,
    versionMismatch:
      batch.version === ownVersion
        ? null
        : `the audit job runs Caelo ${ownVersion} but the admin runs ${batch.version}; the job's image did not follow the last upgrade — run \`cms-provision upgrade\``,
  };
}

async function main(): Promise<void> {
  const raw = process.env[AUDIT_TASK_ENV_VAR];
  if (!raw) {
    throw new Error(`${AUDIT_TASK_ENV_VAR} is not set — the admin passes the task's batch in it`);
  }
  const batch = auditTaskBatchSchema.parse(JSON.parse(raw));
  const { order, versionMismatch } = pickOrder(
    batch,
    process.env[TASK_INDEX_ENV_VAR],
    CAELO_VERSION,
  );
  const store = auditResultStoreFromEnv(process.env);
  const result: AuditTaskResult = versionMismatch
    ? { kind: "fatal", taskId: order.taskId, code: "version-mismatch", message: versionMismatch }
    : await measure(order);
  await store.write(order.resultKey, JSON.stringify(result));
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error("[audit-task] failed:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
