// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pickOrder, readdress } from "../audit-task.js";
import type { AuditTaskBatch, AuditTaskOrder, AuditTaskResult } from "../audit-task-protocol.js";
import { reduceRun } from "../lighthouse-extract.js";
import type { AuditJob } from "../lighthouse-protocol.js";
import {
  type AuditTaskLauncher,
  createParallelAuditRunner,
  planAuditTasks,
} from "../parallel-runner.js";
import { QUALITY_CATEGORIES } from "../ratchet.js";
import { recordedRuns } from "./fixtures/sample-metrics.js";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_A = "00000000-0000-4000-8000-0000000000aa";
const PAGE_B = "00000000-0000-4000-8000-0000000000bb";

const job: AuditJob = {
  pages: [
    { pageId: PAGE_A, url: "http://127.0.0.1:4000/" },
    { pageId: PAGE_B, url: "http://127.0.0.1:4000/about/" },
  ],
  performanceRuns: 3,
};

const [FULL, PERF_ONLY] = recordedRuns();

/** A wire run with the given Performance score (the recorded runs' shape). */
function wire(
  full: boolean,
  performance: number,
): Extract<AuditTaskResult, { kind: "run" }>["run"] {
  const run = full ? reduceRun(FULL, QUALITY_CATEGORIES) : reduceRun(PERF_ONLY, ["performance"]);
  return JSON.parse(JSON.stringify({ ...run, scores: { ...run.scores, performance } }));
}

/** A launcher whose batch finishes after `ticks` progress polls, each task with `answer(order)`. */
function fakeLauncher(
  answer: (order: AuditTaskOrder) => AuditTaskResult | "crash" | "hang",
  ticks = 1,
): AuditTaskLauncher & { batches: AuditTaskBatch[] } {
  const batches: AuditTaskBatch[] = [];
  const store = new Map<string, string>();
  let polls = 0;
  return {
    label: "fake launcher",
    batches,
    async start(batch) {
      batches.push(batch);
      return "execution-1";
    },
    async progress() {
      polls += 1;
      if (polls < ticks) return { failed: 0, finished: false };
      let failed = 0;
      let hanging = 0;
      for (const order of batches[0]?.orders ?? []) {
        const a = answer(order);
        if (a === "crash") failed += 1;
        else if (a === "hang") hanging += 1;
        else store.set(order.resultKey, JSON.stringify(a));
      }
      return { failed, finished: hanging === 0 };
    },
    async readResult(key) {
      return store.get(key) ?? null;
    },
  };
}

function runner(launcher: AuditTaskLauncher, timeoutMs = 60_000) {
  let clock = 0;
  return createParallelAuditRunner({
    launcher,
    timeoutMs,
    pollMs: 1_000,
    jobId: () => JOB_ID,
    version: "1.2.3",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

describe("planAuditTasks", () => {
  it("plans one full run and the Performance runs per page, each with its own result key", () => {
    const tasks = planAuditTasks(job, JOB_ID);
    expect(tasks.map((t) => [t.order.taskId, t.order.categories])).toEqual([
      ["p0-r0", "all"],
      ["p0-r1", "performance"],
      ["p0-r2", "performance"],
      ["p1-r0", "all"],
      ["p1-r1", "performance"],
      ["p1-r2", "performance"],
    ]);
    expect(tasks[4]?.order.resultKey).toBe(`${JOB_ID}/p1-r1.json`);
    expect(tasks[4]?.order.url).toBe("http://127.0.0.1:4000/about/");
  });

  it("passes the staged build source on to every task", () => {
    const stagedBuild = {
      kind: "gcs-staging" as const,
      runId: "00000000-0000-4000-8000-0000000000cc",
      baseUrl: "http://127.0.0.1:4000",
      apiOrigin: "https://example.com",
    };
    for (const t of planAuditTasks({ ...job, stagedBuild }, JOB_ID)) {
      expect(t.order.stagedBuild).toEqual(stagedBuild);
    }
  });
});

describe("createParallelAuditRunner", () => {
  it("starts every task at once and combines each page's runs by its best run", async () => {
    const scores: Record<string, number> = {
      "p0-r0": 89,
      "p0-r1": 100,
      "p0-r2": 87,
      "p1-r0": 95,
      "p1-r1": 94,
      "p1-r2": 93,
    };
    const launcher = fakeLauncher((o) => ({
      kind: "run",
      taskId: o.taskId,
      run: wire(o.categories === "all", scores[o.taskId] as number),
    }));
    const result = await runner(launcher)(job);
    expect(launcher.batches).toHaveLength(1);
    expect(launcher.batches[0]?.version).toBe("1.2.3");
    expect(launcher.batches[0]?.orders).toHaveLength(6);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.pageErrors).toEqual([]);
    expect(result.pages.map((p) => [p.pageId, p.measurement.scores.performance])).toEqual([
      [PAGE_A, 100],
      [PAGE_B, 95],
    ]);
    expect(result.pages[0]?.performanceRuns).toEqual([89, 100, 87]);
    expect(result.pages[0]?.measurement.metrics.runs).toBe(3);
  });

  it("reports a page Lighthouse could not measure as a page error, not the whole audit", async () => {
    const launcher = fakeLauncher((o) =>
      o.pageId === PAGE_B && o.categories === "performance"
        ? { kind: "run-error", taskId: o.taskId, code: "ERRORED_DOCUMENT_REQUEST", message: "404" }
        : { kind: "run", taskId: o.taskId, run: wire(o.categories === "all", 100) },
    );
    const result = await runner(launcher)(job);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.pages.map((p) => p.pageId)).toEqual([PAGE_A]);
    expect(result.pageErrors).toEqual([
      {
        pageId: PAGE_B,
        url: job.pages[1]?.url as string,
        code: "ERRORED_DOCUMENT_REQUEST",
        message: "404",
      },
    ]);
  });

  it("fails the audit loudly when a task cannot start its browser", async () => {
    const launcher = fakeLauncher((o) => ({
      kind: "fatal",
      taskId: o.taskId,
      code: "browser-missing",
      message: "Chromium is not installed",
    }));
    const result = await runner(launcher)(job);
    expect(result).toEqual({
      ok: false,
      failure: { code: "browser-unavailable", message: "Chromium is not installed" },
    });
  });

  it("fails the audit when a task stops without a result", async () => {
    const launcher = fakeLauncher((o) =>
      o.taskId === "p1-r2"
        ? "crash"
        : { kind: "run", taskId: o.taskId, run: wire(o.categories === "all", 100) },
    );
    const result = await runner(launcher)(job);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("child-failed");
    expect(result.failure.message).toContain("p1-r2");
  });

  it("times out instead of waiting forever", async () => {
    const launcher = fakeLauncher(() => "hang");
    const result = await runner(launcher, 5_000)(job);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("timeout");
    expect(result.failure.message).toContain("6 of 6");
  });

  it("fails when the tasks cannot be started", async () => {
    const launcher: AuditTaskLauncher = {
      label: "broken launcher",
      start: async () => {
        throw new Error("permission denied");
      },
      progress: async () => ({ failed: 0, finished: false }),
      readResult: async () => null,
    };
    const result = await runner(launcher)(job);
    expect(result).toEqual({
      ok: false,
      failure: {
        code: "child-failed",
        message: "could not start the audit tasks on broken launcher: permission denied",
      },
    });
  });

  it("rejects a result written for another task", async () => {
    const launcher = fakeLauncher((o) => ({
      kind: "run",
      taskId: "p9-r9",
      run: wire(o.categories === "all", 100),
    }));
    const result = await runner(launcher)(job);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("protocol");
  });
});

describe("pickOrder", () => {
  const batch: AuditTaskBatch = {
    version: "1.2.3",
    orders: planAuditTasks(job, JOB_ID).map((t) => t.order),
  };

  it("picks the order at the Cloud Run task index, or the only one without an index", () => {
    expect(pickOrder(batch, "4", "1.2.3").order.taskId).toBe("p1-r1");
    expect(
      pickOrder({ ...batch, orders: [batch.orders[2] as AuditTaskOrder] }, undefined, "1.2.3").order
        .taskId,
    ).toBe("p0-r2");
  });

  it("names a version mismatch so the task refuses instead of measuring with other code", () => {
    expect(pickOrder(batch, "0", "1.2.3").versionMismatch).toBeNull();
    expect(pickOrder(batch, "0", "1.2.2").versionMismatch).toContain("cms-provision upgrade");
  });

  it("throws for an index outside the batch", () => {
    expect(() => pickOrder(batch, "6", "1.2.3")).toThrow(/no order in a batch of 6/);
    expect(() => pickOrder(batch, "x", "1.2.3")).toThrow();
  });
});

describe("readdress", () => {
  it("moves every URL from the task's loopback origin to the one the admin addressed", () => {
    const result: AuditTaskResult = {
      kind: "run-error",
      taskId: "p0-r0",
      code: "X",
      message: "http://127.0.0.1:5555/about/ failed, see http://127.0.0.1:5555/_assets/a.css",
    };
    expect(readdress(result, "http://127.0.0.1:5555/", "http://127.0.0.1:4000")).toEqual({
      ...result,
      message: "http://127.0.0.1:4000/about/ failed, see http://127.0.0.1:4000/_assets/a.css",
    });
  });
});
