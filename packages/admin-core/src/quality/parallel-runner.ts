// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — run a Lighthouse job as parallel audit tasks, one container
 * per (page, run), instead of one after another in the admin's child
 * process (`lighthouse-runner.ts`).
 *
 * Why separate containers: Lighthouse is CPU-bound and simulates the CPU
 * slowdown from observed task durations, so every run that shares a CPU
 * with another run, or with the editor's chat, measures that interference
 * too (#837, #874). One container per run measures nothing but the page,
 * and all runs finish in about the time of one. Each task calibrates its
 * own host (cpu-calibration.ts), so runs on machines of different speed
 * still emulate the same target device.
 *
 * The provider part is an `AuditTaskLauncher` (start a task with its
 * order, read its state, read its result object); everything else — the
 * fan-out, the wait, combining a page's runs with `combineRuns` — is here,
 * identical on every provider. Every way it can fail ends in a structured
 * `AuditInfraFailure` or a page error, never a silent pass.
 */

import { randomUUID } from "node:crypto";
import { CAELO_VERSION } from "@caelo-cms/shared";
import {
  type AuditTaskBatch,
  type AuditTaskOrder,
  type AuditTaskResult,
  auditTaskResultSchema,
} from "./audit-task-protocol.js";
import { combineRuns, type RunMeasurement } from "./lighthouse-extract.js";
import type { AuditJob } from "./lighthouse-protocol.js";
import type {
  AuditedPage,
  AuditInfraFailure,
  AuditJobResult,
  PageAuditError,
} from "./lighthouse-runner.js";
import type { PageMeasurement } from "./ratchet.js";

/** How far a started batch is. */
export interface AuditBatchProgress {
  /** Tasks that ended without success (their containers stopped). */
  readonly failed: number;
  /** True once no task of the batch runs any more. */
  readonly finished: boolean;
}

/** The provider part of a parallel audit: start, observe, read back. */
export interface AuditTaskLauncher {
  /** Human-readable target for messages, e.g. "Cloud Run job caelo-production-audit". */
  readonly label: string;
  /** Start one task per order of `batch`, all at once; returns a handle for `progress`. */
  start(batch: AuditTaskBatch): Promise<string>;
  progress(handle: string): Promise<AuditBatchProgress>;
  /** A task's result object as text, or null while it is not written. */
  readResult(key: string): Promise<string | null>;
}

export interface ParallelRunnerOptions {
  readonly launcher: AuditTaskLauncher;
  /** Give up on the tasks after this long (default `parallelAuditTimeoutMs`). */
  readonly timeoutMs?: number;
  /** Between two looks at the pending tasks (default 3 s). */
  readonly pollMs?: number;
  /** Sleep between polls (tests pass a fake clock). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The current time in ms (tests pass a fake clock). */
  readonly now?: () => number;
  /** The job id that groups the results (tests pass a fixed one). */
  readonly jobId?: () => string;
  /** The version the tasks must run (default the admin's `CAELO_VERSION`). */
  readonly version?: string;
}

/** Container start + browser start + CPU benchmark + one Lighthouse run
 *  (Lighthouse's own page-load ceiling is ~45 s), with headroom for a cold
 *  image pull. All tasks run at once, so the page count does not add up. */
export function parallelAuditTimeoutMs(): number {
  return 5 * 60_000;
}

interface PlannedTask {
  readonly order: AuditTaskOrder;
  readonly pageIndex: number;
  readonly runIndex: number;
}

/** The tasks of a job: per page one full run, then its Performance runs. Pure. */
export function planAuditTasks(job: AuditJob, jobId: string): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  job.pages.forEach((page, pageIndex) => {
    for (let runIndex = 0; runIndex < job.performanceRuns; runIndex += 1) {
      const taskId = `p${pageIndex}-r${runIndex}`;
      tasks.push({
        pageIndex,
        runIndex,
        order: {
          jobId,
          taskId,
          pageId: page.pageId,
          url: page.url,
          categories: runIndex === 0 ? "all" : "performance",
          ...(job.stagedBuild ? { stagedBuild: job.stagedBuild } : {}),
          resultKey: `${jobId}/${taskId}.json`,
        },
      });
    }
  });
  return tasks;
}

function failure(code: AuditInfraFailure["code"], message: string): AuditJobResult {
  return { ok: false, failure: { code, message } };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A Lighthouse runner (the `runJob` shape `audit-worker.ts` takes) that fans
 * the job out to parallel tasks through `launcher`.
 */
export function createParallelAuditRunner(
  options: ParallelRunnerOptions,
): (job: AuditJob) => Promise<AuditJobResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? parallelAuditTimeoutMs();
  const { launcher } = options;

  return async (job) => {
    const tasks = planAuditTasks(job, options.jobId?.() ?? randomUUID());
    let handle: string;
    try {
      handle = await launcher.start({
        version: options.version ?? CAELO_VERSION,
        orders: tasks.map((t) => t.order),
      });
    } catch (e) {
      return failure(
        "child-failed",
        `could not start the audit tasks on ${launcher.label}: ${errorMessage(e)}`,
      );
    }

    const results = new Map<number, AuditTaskResult>();
    const deadline = now() + timeoutMs;
    for (;;) {
      const read = await readPending(launcher, tasks, results);
      if (read) return read;
      if (results.size === tasks.length) break;
      let progress: AuditBatchProgress;
      try {
        progress = await launcher.progress(handle);
      } catch (e) {
        return failure(
          "child-failed",
          `could not read the audit tasks' state on ${launcher.label}: ${errorMessage(e)}`,
        );
      }
      if (progress.failed > 0 || progress.finished) {
        // A task writes its result before it exits, and the object stores
        // are read-after-write consistent: read once more for results
        // written since the read above; what is still missing never comes.
        const again = await readPending(launcher, tasks, results);
        if (again) return again;
        const missing = tasks.filter((_, i) => !results.has(i)).map((t) => t.order.taskId);
        if (missing.length > 0) {
          return failure(
            "child-failed",
            `${missing.length} audit task(s) on ${launcher.label} stopped without a result (${missing.join(", ")}); the job's execution log names the cause`,
          );
        }
        break;
      }
      if (now() >= deadline) {
        return failure(
          "timeout",
          `${tasks.length - results.size} of ${tasks.length} audit task(s) on ${launcher.label} did not finish within ${Math.round(timeoutMs / 1000)} s`,
        );
      }
      await sleep(pollMs);
    }
    return assemble(job, tasks, results);
  };
}

/** Read every result not read yet into `results`; a failure ends the audit. */
async function readPending(
  launcher: AuditTaskLauncher,
  tasks: readonly PlannedTask[],
  results: Map<number, AuditTaskResult>,
): Promise<AuditJobResult | null> {
  for (const [i, task] of tasks.entries()) {
    if (results.has(i)) continue;
    let text: string | null;
    try {
      text = await launcher.readResult(task.order.resultKey);
    } catch (e) {
      return failure(
        "protocol",
        `could not read audit result ${task.order.resultKey}: ${errorMessage(e)}`,
      );
    }
    if (text === null) continue;
    const parsed = auditTaskResultSchema.safeParse(safeJson(text));
    if (!parsed.success || parsed.data.taskId !== task.order.taskId) {
      return failure(
        "protocol",
        `invalid audit result ${task.order.resultKey}: ${parsed.success ? "wrong task id" : parsed.error.message.slice(0, 300)}`,
      );
    }
    results.set(i, parsed.data);
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Combine every page's task results, in run order. Exported for tests. */
export function assemble(
  job: AuditJob,
  tasks: readonly PlannedTask[],
  results: ReadonlyMap<number, AuditTaskResult>,
): AuditJobResult {
  const fatal = [...results.values()].find((r) => r.kind === "fatal");
  if (fatal && fatal.kind === "fatal") {
    return failure(
      fatal.code.startsWith("browser-") ? "browser-unavailable" : "child-failed",
      fatal.message,
    );
  }
  const pages: AuditedPage[] = [];
  const pageErrors: PageAuditError[] = [];
  job.pages.forEach((page, pageIndex) => {
    const own = tasks
      .map((t, i) => ({ t, r: results.get(i) }))
      .filter(({ t }) => t.pageIndex === pageIndex)
      .sort((a, b) => a.t.runIndex - b.t.runIndex);
    const error = own.find(({ r }) => r?.kind === "run-error")?.r;
    if (error && error.kind === "run-error") {
      pageErrors.push({
        pageId: page.pageId,
        url: page.url,
        code: error.code,
        message: error.message,
      });
      return;
    }
    const runs = own.map(({ r }) => (r as Extract<AuditTaskResult, { kind: "run" }>).run);
    try {
      const { measurement, performanceRuns } = combineRuns(runs as RunMeasurement[]);
      const finalUrl = runs[0]?.finalUrl;
      pages.push({
        pageId: page.pageId,
        url: page.url,
        ...(finalUrl ? { finalUrl } : {}),
        measurement: measurement as PageMeasurement,
        performanceRuns,
      });
    } catch (e) {
      pageErrors.push({
        pageId: page.pageId,
        url: page.url,
        code: "PROTOCOL",
        message: `the audit tasks' results for this page do not combine: ${errorMessage(e)}`,
      });
    }
  });
  return { ok: true, pages, pageErrors };
}
