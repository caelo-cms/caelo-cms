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
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";
import {
  countNewMatches,
  POOL_EXHAUSTED,
  percentile,
  readFirstPaint,
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
      "shared_preload_libraries=pg_stat_statements",
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
