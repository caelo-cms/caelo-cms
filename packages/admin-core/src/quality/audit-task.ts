// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — one parallel audit task: its share of a batch's Lighthouse
 * runs, one after another, in its own short-lived container (Cloud Run job
 * / Fargate task / Container Apps job), started by the audit runner's
 * parallel runner (`parallel-runner.ts`). A task runs more than one order
 * when the project's CPU quota allows fewer runs at once than the batch
 * has (reporting-jobs/run-capacity.ts); each run still has the container
 * to itself, so it measures nothing but its page.
 *
 *   CAELO_AUDIT_TASK='<AuditTaskOrder JSON>' bun packages/admin-core/src/quality/audit-task.ts
 *
 * Least privilege: the task's identity can read the staged build and write
 * into the audit results store, nothing else — no database, no secrets, no
 * provider keys. The order comes from the admin; the task trusts nothing
 * else and validates it.
 *
 * Exit code 0 means a result was written for every order of the task (a
 * page Lighthouse could not measure is a written `run-error`, not a
 * crash). Any other exit leaves the rest without a result, and the runner
 * reports the task as failed with a pointer to its log.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { auditResultStoreFromEnv } from "./audit-results-store.js";
import {
  AUDIT_TASK_ENV_VAR,
  type AuditTaskBatch,
  type AuditTaskOrder,
  type AuditTaskResult,
  auditTaskBatchSchema,
  TASK_COUNT_ENV_VAR,
  TASK_INDEX_ENV_VAR,
} from "./audit-task-protocol.js";
import { LighthouseRunError, type RunMeasurement } from "./lighthouse-extract.js";
import { startLighthouseSession } from "./lighthouse-session.js";
import { createLoopbackTls } from "./loopback-tls.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";
import { onOrigin, readdressed } from "./readdress.js";
import { serveStagedBuild, stagingSlotSource } from "./staged-origin.js";

/**
 * Re-address every occurrence of one origin in a result (page URL, final
 * URL, flagged resource URLs) to another. The admin reads the result on
 * the origin it addressed the page on, so a task that served the build on
 * its own loopback port reports as if it had used the admin's.
 */
export function readdress(result: AuditTaskResult, from: string, to: string): AuditTaskResult {
  return readdressed(result, from, to);
}

async function measure(order: AuditTaskOrder): Promise<AuditTaskResult> {
  let url = order.url;
  let close: (() => Promise<void>) | undefined;
  let taskBase: string | null = null;
  let trustSpki: string | undefined;
  if (order.stagedBuild) {
    // HTTP/2 over TLS, as the CDN serves staging (staged-origin.ts).
    const origin = await serveStagedBuild(
      stagingSlotSource(order.stagedBuild.location, order.stagedBuild.runId),
      { browserTls: createLoopbackTls() },
    );
    close = origin.close;
    if (!origin.browser) {
      await close();
      throw new Error("staged origin: served without the browser's TLS listener");
    }
    taskBase = origin.browser.baseUrl;
    trustSpki = origin.browser.trustSpki;
    try {
      url = onOrigin(url, order.stagedBuild.baseUrl, taskBase);
    } catch (e) {
      await close();
      throw e;
    }
  }
  let result: AuditTaskResult;
  try {
    result = await runOnce(order.taskId, url, order.categories, trustSpki);
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
  trustSpki: string | undefined,
): Promise<AuditTaskResult> {
  const started = await startLighthouseSession(trustSpki ? { trustSpki } : {});
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
 * This task's orders from the batch, or why there are none: task `index`
 * of `count` runs every order whose position is `index` modulo `count`.
 * Pure; exported for tests.
 *
 * @param index - `CLOUD_RUN_TASK_INDEX`; absent on providers that start one
 *   task per order (a batch of one).
 * @param count - `CLOUD_RUN_TASK_COUNT`; absent: one task per order.
 */
export function pickOrders(
  batch: AuditTaskBatch,
  index: string | undefined,
  count: string | undefined,
  ownVersion: string,
): { orders: AuditTaskOrder[]; versionMismatch: string | null } {
  const i = index === undefined ? 0 : Number(index);
  const n = count === undefined ? batch.orders.length : Number(count);
  if (!Number.isInteger(n) || n < 1 || n > batch.orders.length) {
    throw new Error(`task count ${count} does not fit a batch of ${batch.orders.length}`);
  }
  if (!Number.isInteger(i) || i < 0 || i >= n) {
    throw new Error(`task index ${index ?? "(none)"} is not one of ${n} task(s)`);
  }
  return {
    orders: batch.orders.filter((_, k) => k % n === i),
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
  const { orders, versionMismatch } = pickOrders(
    batch,
    process.env[TASK_INDEX_ENV_VAR],
    process.env[TASK_COUNT_ENV_VAR],
    CAELO_VERSION,
  );
  const store = auditResultStoreFromEnv(process.env);
  // One after another: two runs at once would share the container's CPU
  // and measure each other.
  for (const order of orders) {
    const result: AuditTaskResult = versionMismatch
      ? { kind: "fatal", taskId: order.taskId, code: "version-mismatch", message: versionMismatch }
      : await measure(order);
    await store.write(order.resultKey, JSON.stringify(result));
  }
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
