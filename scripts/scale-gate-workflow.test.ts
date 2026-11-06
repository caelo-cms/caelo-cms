// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #1267 — the scale gate's workflow keeps the environment the SLOs
 * are defined against (docs/dev/scale-gate.md), and the runner's report
 * logic counts what the gate promises to count.
 *
 * W1: nightly, and on a pull request only with the `perf-gate` label.
 * W2: the admin runs pinned to 1 vCPU / 2 GiB.
 * W3: Postgres is db-f1-micro sized (≈0.6 GB, 100 connections) with the
 *     lock-wait logging the lock SLO is read from.
 * W4: no `run:` interpolates a `${{ … }}` expression (values come through
 *     `env:`), and the token can only read the repository.
 * W5: the load step fails the job on an SLO miss (pipefail through tee).
 * W6 (#1390): Postgres runs under the db-f1-micro CPU share (0.2 vCPU)
 *     before the admin starts, and the load samples its CPU, drives the
 *     scheduler tick and waits for the plugins' change consumers.
 * W7 (#1390): the fixture activates every plugin in packages/plugins/.
 * W8 (#1269): Postgres logs the plans of slow statements (auto_explain,
 *     JSON, actual rows + buffers) and the report reads them back.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";
import {
  addTick,
  countPluginFailures,
  cpuSampleBetween,
  parseCpuMax,
  parseCpuStat,
  summariseCpu,
} from "./scale-gate/observe.ts";
import { groupSlowPlans, parseLoggedPlans, renderPlan } from "./scale-gate/plans.ts";
import { SHIPPED_PLUGIN_SLUGS } from "./scale-gate/plugins.ts";
import {
  countNewMatches,
  markdownCell,
  notRunning,
  POOL_EXHAUSTED,
  percentile,
  pluginsPass,
  readFirstPaint,
  retryAfterSeconds,
  summarise,
} from "./scale-gate/run.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<
    string,
    { if?: string; steps: Step[]; permissions?: Record<string, string> }
  >;
}

const wf = yaml.load(
  readFileSync(resolve(REPO_ROOT, ".github/workflows/scale-gate.yml"), "utf8"),
) as Workflow;
const job = wf.jobs["scale-gate"];
const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");

describe("scale-gate.yml", () => {
  it("W1: runs nightly and on labeled pull requests only", () => {
    expect(wf.on.schedule).toBeDefined();
    expect(wf.on.pull_request).toBeDefined();
    expect(job?.if).toContain("'perf-gate'");
  });

  it("W2: pins the admin to 1 vCPU and 2 GiB", () => {
    expect(runs).toContain("--cpus=1 --memory=2g");
  });

  it("W3: sizes Postgres like db-f1-micro and logs lock waits over 100 ms", () => {
    for (const flag of [
      "--memory=614m",
      "max_connections=100",
      "deadlock_timeout=100ms",
      "log_lock_waits=on",
      "shared_preload_libraries=pg_stat_statements,auto_explain",
      // #1269: the slow statements' plans, read back by plans.ts (JSON).
      "auto_explain.log_min_duration=2s",
      "auto_explain.log_analyze=on",
      "auto_explain.log_buffers=on",
      "auto_explain.log_timing=off",
      "auto_explain.log_format=json",
    ]) {
      expect(runs).toContain(flag);
    }
  });

  it("W4: no expression in a run script, read-only token", () => {
    for (const s of job?.steps ?? []) expect(s.run ?? "").not.toContain("${{");
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toEqual({ contents: "read" });
  });

  it("W5: an SLO miss fails the load step", () => {
    const load = job?.steps.find((s) => s.name === "Run the load")?.run ?? "";
    expect(load).toContain("set -o pipefail");
    expect(load).not.toContain("--baseline");
  });

  it("W6: Postgres gets the db-f1-micro CPU share before the admin starts", () => {
    const steps = job?.steps ?? [];
    const cap = steps.findIndex((s) =>
      (s.run ?? "").includes("docker update --cpus=0.2 scale-gate-pg"),
    );
    const admin = steps.findIndex((s) => s.name === "Start the admin (1 vCPU, 2 GiB)");
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(admin);
    expect(steps[cap]?.run).toContain('= "20000 100000"');
    const load = steps.find((s) => s.name === "Run the load")?.run ?? "";
    for (const flag of ["--pg-container scale-gate-pg", "--tick-every 60", "--settle-consumers"]) {
      expect(load).toContain(flag);
    }
    // The load drives the tick; the admin's own dev clock would double it.
    expect(steps[admin]?.run).toContain("CAELO_SCHEDULER_CLOCK=off");
    expect(steps[admin]?.run).toContain("-e CAELO_INTERNAL_SECRET");
  });

  it("W7: the fixture activates every shipped plugin", () => {
    const dirs = readdirSync(resolve(REPO_ROOT, "packages/plugins"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...SHIPPED_PLUGIN_SLUGS].sort()).toEqual(dirs);
    const fixture = readFileSync(resolve(REPO_ROOT, "scripts/scale-gate/fixture.ts"), "utf8");
    expect(fixture).toContain("testPlugins: SHIPPED_PLUGINS.map(");
    // ratings requires consent-manager: dependencies first.
    expect(SHIPPED_PLUGIN_SLUGS.indexOf("consent-manager")).toBeLessThan(
      SHIPPED_PLUGIN_SLUGS.indexOf("ratings"),
    );
  });
});

describe("scale-gate observation (#1390)", () => {
  it("reads a cgroup's CPU counters and quota", () => {
    expect(
      parseCpuStat(
        "usage_usec 1500000\nuser_usec 1\nnr_periods 10\nnr_throttled 4\nthrottled_usec 900\n",
      ),
    ).toEqual({ usageUsec: 1_500_000, nrThrottled: 4, throttledUsec: 900 });
    expect(() => parseCpuStat("nr_periods 1\n")).toThrow("usage_usec");
    expect(parseCpuMax("20000 100000\n")).toBe(0.2);
    expect(parseCpuMax("max 100000")).toBeNull();
  });

  it("turns two reads into CPUs used and throttled periods", () => {
    const a = { usageUsec: 0, nrThrottled: 0, throttledUsec: 0, atMs: 0 };
    const b = { usageUsec: 1_000_000, nrThrottled: 50, throttledUsec: 0, atMs: 5000 };
    const s = cpuSampleBetween(a, b, 100_000);
    expect(s.cpus).toBe(0.2);
    expect(s.throttledPeriods).toBe(1);
    const sum = summariseCpu("pg", 0.2, 5, [s, { atMs: 10_000, cpus: 0.05, throttledPeriods: 0 }]);
    expect(sum.meanCpus).toBe(0.125);
    expect(sum.p95Cpus).toBe(0.2);
    expect(sum.saturatedSamplesPct).toBe(50);
    expect(sum.meanThrottledPeriodsPct).toBe(50);
  });

  it("counts plugin failures per plugin from the admin log", () => {
    const log = [
      "[plugin-host] consent-manager operation failed (timeout) on local/1: statement timeout",
      '[plugin-host] change consumer of "consent-manager" stopped: canceling statement',
      "[plugin-host] international-site render failed (plugin) on local/1: x",
      "[plugin-host] draining the change consumers failed",
      "[plugin-host] could not record the forms operation failure: x",
      "[hooks] plugin host: 7 loaded",
    ].join("\n");
    expect(countPluginFailures(log)).toEqual({
      "consent-manager": 2,
      "international-site": 1,
      "(host)": 1,
    });
  });

  it("fails on a failed worker run or tick, and finds plugins list_plugins does not run", () => {
    const ticks = { ticks: 0, tickErrors: 0, workers: {}, coreFailures: [] as string[] };
    addTick(ticks, [
      { key: "plugin:ratings/refresh_aggregates", outcome: "ok", durationMs: 12, detail: null },
      { key: "core:proposal-gc", outcome: "failed", durationMs: 1, detail: "x" },
    ]);
    expect(pluginsPass({}, ticks)).toBe(true);
    expect(ticks.coreFailures).toHaveLength(1);
    addTick(ticks, [
      {
        key: "plugin:ratings/refresh_aggregates",
        outcome: "timed_out",
        durationMs: 9,
        detail: null,
      },
    ]);
    expect(pluginsPass({}, ticks)).toBe(false);
    expect(pluginsPass({ forms: 1 }, null)).toBe(false);
    const listed =
      "plugins[2]{slug,status,version,health,requires,required_by,problem}:\n  forms,active,1.0.0,running,,,\n  ratings,active,1.0.0,failing,consent-manager,,boom";
    expect(notRunning(listed, ["forms", "ratings", "auth"])).toEqual(["ratings", "auth"]);
  });
});

describe("scale-gate runner report", () => {
  it("nearest-rank percentiles", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);
  });

  it("a class passes only with samples, no errors, no timeouts and p95 under target", () => {
    expect(summarise([10, 20, 30], 0, 0, 100).pass).toBe(true);
    expect(summarise([], 0, 0, 100).pass).toBe(false);
    expect(summarise([10], 1, 0, 100).pass).toBe(false);
    expect(summarise([10], 0, 1, 100).pass).toBe(false);
    expect(summarise([10, 200], 0, 0, 100).pass).toBe(false);
    // A call the admin refused with 429 is back-pressure: overloaded, not met.
    expect(summarise([10, 20], 0, 0, 100, 1)).toMatchObject({ refused: 1, pass: false });
  });

  it("escapes a statement for a markdown cell: backslash, pipe, backtick, line breaks", () => {
    expect(markdownCell("a\\b | `c`\nd")).toBe("a\\\\b \\| \\`c\\` d");
  });

  it("waits as long as a 429 asks (#1375), 5 s when it names nothing", () => {
    expect(
      retryAfterSeconds('{"message":"Caelo is at capacity right now: ... Wait 10 s, then send"}'),
    ).toBe(10);
    expect(retryAfterSeconds("busy")).toBe(5);
  });

  it("counts only log lines written after the run started", () => {
    const dir = mkdtempSync(join(tmpdir(), "scale-gate-"));
    try {
      const log = join(dir, "admin.log");
      writeFileSync(log, "PoolAcquireTimeoutError before\n");
      const start = readFileSync(log).length;
      writeFileSync(
        log,
        "PoolAcquireTimeoutError before\nok\nthe admin database pool had no free connection for x\nPoolAcquireTimeoutError\n",
      );
      expect(countNewMatches(log, start, POOL_EXHAUSTED)).toBe(2);
      expect(countNewMatches(null, 0, POOL_EXHAUSTED)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scale-gate first paint (#1268)", () => {
  it("ends at </html>, before the streamed parts SvelteKit appends", async () => {
    let more = () => {};
    const tail = new Promise<void>((resolve) => {
      more = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("<!doctype html><html><body>editor"));
        controller.enqueue(encoder.encode("</body></html>\n"));
        // A streamed part that settles only later.
        await tail;
        controller.enqueue(encoder.encode("<script>resolve(1)</script>"));
        controller.close();
      },
    });
    const text = await readFirstPaint(new Response(body, { status: 200 }));
    expect(text).toContain("</html>");
    expect(text).not.toContain("resolve(1)");
    more();
  });

  it("fails on a status other than 200 and on a document without </html>", async () => {
    await expect(readFirstPaint(new Response("down", { status: 500 }))).rejects.toThrow("HTTP 500");
    await expect(readFirstPaint(new Response("<html>", { status: 200 }))).rejects.toThrow(
      "without </html>",
    );
  });
});

describe("scale-gate slow plans (#1269)", () => {
  const prefix = "2026-11-06 10:00:00.000 UTC [42] ";
  const entry = (ms: number, query: string, plan: object) =>
    [
      `${prefix}LOG:  duration: ${ms} ms  plan:`,
      ...JSON.stringify({ "Query Text": query, Plan: plan }, null, 2)
        .split("\n")
        .map((l) => `\t${l}`),
    ].join("\n");
  const scan = {
    "Node Type": "Index Scan",
    "Index Name": "entity_changes_kind_xid_idx",
    "Relation Name": "entity_changes",
    "Actual Rows": 3,
    "Actual Loops": 1,
    "Shared Hit Blocks": 13000,
    "Shared Read Blocks": 700,
    "Index Cond": "(kind = ANY ($1))",
    Filter: "(op <> 'insert'::text)",
    "Rows Removed by Filter": 99000,
  };

  it("reads JSON plans out of the log between other lines, skipping a cut one", () => {
    const log = [
      `${prefix}LOG:  checkpoint starting: time`,
      entry(8123.5, "SELECT 1\n  FROM entity_changes", { "Node Type": "Limit", Plans: [scan] }),
      `${prefix}LOG:  process 7 still waiting for ShareLock`,
      `${prefix}LOG:  duration: 3000 ms  plan:`,
      '\t{ "Query Text": "cut',
      entry(2500, "SELECT 1 FROM entity_changes", scan),
    ].join("\n");
    const plans = parseLoggedPlans(log);
    expect(plans.map((p) => [p.durationMs, p.query])).toEqual([
      [8123.5, "SELECT 1 FROM entity_changes"],
      [2500, "SELECT 1 FROM entity_changes"],
    ]);
  });

  it("groups by statement and keeps the slowest plan, rendered with rows and buffers", () => {
    const log = [
      entry(2500, "SELECT a", scan),
      entry(9000, "SELECT a", { "Node Type": "Limit", Plans: [scan] }),
      entry(4000, "SELECT b", scan),
    ].join("\n");
    const groups = groupSlowPlans(parseLoggedPlans(log), 10);
    expect(groups.map((g) => [g.query, g.count, g.totalMs, g.maxMs])).toEqual([
      ["SELECT a", 2, 11500, 9000],
      ["SELECT b", 1, 4000, 4000],
    ]);
    expect(groups[0]?.plan.split("\n")).toEqual([
      "Limit (rows=? loops=? buffers=0)",
      "  Index Scan using entity_changes_kind_xid_idx on entity_changes (rows=3 loops=1 buffers=13700 (read 700) removed by filter=99000)",
      "      Index Cond: (kind = ANY ($1))",
      "      Filter: (op <> 'insert'::text)",
    ]);
    expect(renderPlan(scan)).toStartWith("Index Scan using");
  });
});
