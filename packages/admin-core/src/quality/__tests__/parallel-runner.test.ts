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
  planConfirmationTasks,
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

/** A launcher whose batches each finish after `ticks` progress polls, each task with `answer(order)`. */
function fakeLauncher(
  answer: (order: AuditTaskOrder) => AuditTaskResult | "crash" | "hang",
  ticks = 1,
): AuditTaskLauncher & { batches: AuditTaskBatch[] } {
  const batches: AuditTaskBatch[] = [];
  const store = new Map<string, string>();
  const polls = new Map<string, number>();
  return {
    label: "fake launcher",
    batches,
    async start(batch) {
      batches.push(batch);
      return `execution-${batches.length}`;
    },
    async progress(handle) {
      const n = (polls.get(handle) ?? 0) + 1;
      polls.set(handle, n);
      if (n < ticks) return { failed: 0, finished: false };
      let failed = 0;
      let hanging = 0;
      const batch = batches[Number(handle.slice("execution-".length)) - 1];
      for (const order of batch?.orders ?? []) {
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
      kind: "staging-slot" as const,
      location: "_slots/a",
      runId: "00000000-0000-4000-8000-0000000000cc",
      baseUrl: "http://127.0.0.1:4000",
    };
    for (const t of planAuditTasks({ ...job, stagedBuild }, JOB_ID)) {
      expect(t.order.stagedBuild).toEqual(stagedBuild);
    }
  });
});

describe("planConfirmationTasks", () => {
  const tasks = planAuditTasks(job, JOB_ID);
  const answered = (score: (taskId: string) => number | "error") =>
    new Map<number, AuditTaskResult>(
      tasks.map((t, i) => {
        const s = score(t.order.taskId);
        return [
          i,
          s === "error"
            ? { kind: "run-error", taskId: t.order.taskId, code: "X", message: "404" }
            : { kind: "run", taskId: t.order.taskId, run: wire(t.runIndex === 0, s) },
        ];
      }),
    );

  it("plans the runs up to five for a disagreeing page only", () => {
    const extra = planConfirmationTasks(
      job,
      tasks,
      answered((id) => (id === "p1-r1" ? 90 : 100)),
    );
    expect(extra.map((t) => [t.order.taskId, t.pageIndex, t.runIndex])).toEqual([
      ["p1-r3", 1, 3],
      ["p1-r4", 1, 4],
    ]);
  });

  it("plans nothing for a page with a run error: it is reported as it is", () => {
    const extra = planConfirmationTasks(
      job,
      tasks,
      answered((id) => (id === "p0-r1" ? "error" : id === "p0-r2" ? 50 : 100)),
    );
    expect(extra).toEqual([]);
  });
});

describe("createParallelAuditRunner", () => {
  it("starts every task at once and combines each page's agreeing runs by its best run", async () => {
    const scores: Record<string, number> = {
      "p0-r0": 99,
      "p0-r1": 100,
      "p0-r2": 98,
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
    expect(result.pages[0]?.performanceRuns).toEqual([99, 100, 98]);
    expect(result.pages[0]?.measurement.metrics).toMatchObject({ runs: 3, scoredBy: "best" });
  });

  it("confirms a page whose runs disagree in a second batch and scores it by the median of five (#1370)", async () => {
    // Page A: 100/100/91 (#1370's host contention) -> 2 more runs; page B agrees.
    const scores: Record<string, number> = {
      "p0-r0": 100,
      "p0-r1": 100,
      "p0-r2": 91,
      "p0-r3": 92,
      "p0-r4": 93,
      "p1-r0": 100,
      "p1-r1": 99,
      "p1-r2": 100,
    };
    const launcher = fakeLauncher((o) => ({
      kind: "run",
      taskId: o.taskId,
      run: wire(o.categories === "all", scores[o.taskId] as number),
    }));
    const result = await runner(launcher)(job);
    expect(launcher.batches).toHaveLength(2);
    expect(launcher.batches[1]?.orders.map((o) => [o.taskId, o.categories, o.pageId])).toEqual([
      ["p0-r3", "performance", PAGE_A],
      ["p0-r4", "performance", PAGE_A],
    ]);
    expect(launcher.batches[1]?.orders[0]?.resultKey).toBe(`${JOB_ID}/p0-r3.json`);
    if (!result.ok) throw new Error(result.failure.message);
    const [a, b] = result.pages;
    expect(a?.performanceRuns).toEqual([100, 100, 91, 92, 93]);
    // ranked 100, 100, 93, 92, 91: the median is 93, not the best run's 100.
    expect(a?.measurement.scores.performance).toBe(93);
    expect(a?.measurement.metrics).toMatchObject({ runs: 5, scoredBy: "median" });
    expect(b?.measurement.scores.performance).toBe(100);
    expect(b?.measurement.metrics).toMatchObject({ runs: 3, scoredBy: "best" });
  });

  it("starts no confirmation batch when every page's runs agree", async () => {
    const launcher = fakeLauncher((o) => ({
      kind: "run",
      taskId: o.taskId,
      run: wire(o.categories === "all", 100),
    }));
    const result = await runner(launcher)(job);
    expect(result.ok).toBe(true);
    expect(launcher.batches).toHaveLength(1);
  });

  it("fails the audit loudly when a confirmation task stops without a result", async () => {
    const scores: Record<string, number> = { "p0-r0": 100, "p0-r1": 80, "p0-r2": 100 };
    const launcher = fakeLauncher((o) =>
      o.taskId === "p0-r4"
        ? "crash"
        : {
            kind: "run",
            taskId: o.taskId,
            run: wire(o.categories === "all", scores[o.taskId] ?? 100),
          },
    );
    const result = await runner(launcher)(job);
    expect(launcher.batches).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("child-failed");
    expect(result.failure.message).toContain("p0-r4");
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
