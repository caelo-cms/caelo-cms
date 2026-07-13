// SPDX-License-Identifier: MPL-2.0

/**
 * issue #268 — unit tests for the parallel-fan-out core of
 * `spawn_subagents`. These exercise `runSubagentBatch` with a MOCK spawn
 * fn (no chat-runner, no DB, no provider), asserting the two properties
 * the concurrency + budget logic must hold:
 *
 *   1. Concurrency cap: at most `maxParallel` spawns are ever in flight.
 *   2. Batch-cost abort: once the running spend crosses
 *      `batchMaxCostMicrocents`, remaining specs are skipped (never
 *      invoke the spawn fn) and reported as `batch-aborted`.
 *   3. Over-budget signal: the final total exceeding the cap is flagged
 *      even when the last child tips it over with nothing left to skip
 *      (Copilot #291-1).
 *
 * Plus order preservation, n-of-m progress emission, and the
 * `parsePositiveIntEnv` guard against NaN-poisoned caps (Copilot #291-2).
 */

import { describe, expect, it } from "bun:test";
import type { SpawnSubagentToolInput } from "@caelo-cms/shared";

import { parsePositiveIntEnv, runSubagentBatch } from "../tools/spawn-subagent.js";

/** Minimal valid-enough spec; runSubagentBatch only reads `.role`. */
function spec(role: string): SpawnSubagentToolInput {
  return {
    role,
    task: `task for ${role}`,
    expectedReturnShape: "freeform",
    maxCostMicrocents: 50_000_000,
    timeoutMs: 60_000,
  } as SpawnSubagentToolInput;
}

/** A resolved-in-`ms` mock spawn result carrying `cost` microcents. */
function completed(role: string, cost: number, durationMs = 0) {
  return {
    role,
    status: "completed" as const,
    resultJson: { text: role },
    costMicrocents: cost,
    durationMs,
    subagentChatSessionId: `sess-${role}`,
  };
}

describe("runSubagentBatch — concurrency cap (issue #268)", () => {
  it("never runs more than maxParallel spawns at once", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => spec(`r${i}`));
    let inFlight = 0;
    let observedMax = 0;

    const outcome = await runSubagentBatch(
      specs,
      async (s) => {
        inFlight += 1;
        observedMax = Math.max(observedMax, inFlight);
        // Yield across a macrotask so sibling workers interleave — a
        // synchronous resolve would never let two overlap.
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return completed(s.role, 0);
      },
      { maxParallel: 3, batchMaxCostMicrocents: Number.MAX_SAFE_INTEGER },
    );

    expect(observedMax).toBe(3);
    expect(outcome.ran).toBe(12);
    expect(outcome.results).toHaveLength(12);
    expect(outcome.batchAborted).toBe(false);
  });

  it("caps concurrency at the spec count when maxParallel exceeds it", async () => {
    const specs = Array.from({ length: 2 }, (_, i) => spec(`r${i}`));
    let inFlight = 0;
    let observedMax = 0;

    await runSubagentBatch(
      specs,
      async (s) => {
        inFlight += 1;
        observedMax = Math.max(observedMax, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return completed(s.role, 0);
      },
      { maxParallel: 8, batchMaxCostMicrocents: Number.MAX_SAFE_INTEGER },
    );

    expect(observedMax).toBe(2);
  });

  it("preserves input order in results despite out-of-order completion", async () => {
    const specs = [spec("slow"), spec("fast")];
    const outcome = await runSubagentBatch(
      specs,
      async (s) => {
        // "slow" finishes AFTER "fast" so completion order != input order.
        await new Promise((r) => setTimeout(r, s.role === "slow" ? 20 : 1));
        return completed(s.role, 0);
      },
      { maxParallel: 2, batchMaxCostMicrocents: Number.MAX_SAFE_INTEGER },
    );
    expect(outcome.results.map((r) => r.role)).toEqual(["slow", "fast"]);
  });
});

describe("runSubagentBatch — batch-cost abort (issue #268)", () => {
  it("skips remaining spawns once the batch cap is exceeded", async () => {
    const specs = Array.from({ length: 5 }, (_, i) => spec(`r${i}`));
    const calledRoles: string[] = [];

    // Sequential (maxParallel=1) makes the abort boundary deterministic:
    // r0 → running=60, r1 → running=120 (> cap 100) so r2..r4 are skipped
    // before ever calling the spawn fn.
    const outcome = await runSubagentBatch(
      specs,
      async (s) => {
        calledRoles.push(s.role);
        return completed(s.role, 60);
      },
      { maxParallel: 1, batchMaxCostMicrocents: 100 },
    );

    expect(calledRoles).toEqual(["r0", "r1"]);
    expect(outcome.ran).toBe(2);
    expect(outcome.batchAborted).toBe(true);
    expect(outcome.totalCostMicrocents).toBe(120);

    // r0 + r1 completed; r2..r4 are batch-aborted with zero cost.
    expect(outcome.results.map((r) => r.status)).toEqual([
      "completed",
      "completed",
      "errored",
      "errored",
      "errored",
    ]);
    const aborted = outcome.results.slice(2);
    for (const r of aborted) {
      expect(r.errorKind).toBe("batch-aborted");
      expect(r.costMicrocents).toBe(0);
      expect(r.errorMessage).toContain("not started");
    }
  });

  it("does not abort when the batch stays under the cap", async () => {
    const specs = Array.from({ length: 3 }, (_, i) => spec(`r${i}`));
    const outcome = await runSubagentBatch(specs, async (s) => completed(s.role, 10), {
      maxParallel: 2,
      batchMaxCostMicrocents: 1000,
    });
    expect(outcome.batchAborted).toBe(false);
    expect(outcome.overBudget).toBe(false);
    expect(outcome.ran).toBe(3);
    expect(outcome.totalCostMicrocents).toBe(30);
    expect(outcome.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("flags overBudget when the LAST child tips the total over the cap with nothing to skip (Copilot #291-1)", async () => {
    // 2 specs, sequential, each costs 60, cap 100. r0 → running 60 (not
    // over yet, so r1 still starts), r1 → running 120. Both ran, no spec
    // was ever skipped (batchAborted stays false) yet the ceiling was
    // blown — the exact case a batchAborted-only guard misses.
    const specs = Array.from({ length: 2 }, (_, i) => spec(`r${i}`));
    const outcome = await runSubagentBatch(specs, async (s) => completed(s.role, 60), {
      maxParallel: 1,
      batchMaxCostMicrocents: 100,
    });
    expect(outcome.ran).toBe(2);
    expect(outcome.totalCostMicrocents).toBe(120);
    expect(outcome.batchAborted).toBe(false); // nothing skipped
    expect(outcome.overBudget).toBe(true); // but the cap WAS exceeded
    expect(outcome.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("batchAborted always implies overBudget", async () => {
    const specs = Array.from({ length: 4 }, (_, i) => spec(`r${i}`));
    const outcome = await runSubagentBatch(specs, async (s) => completed(s.role, 60), {
      maxParallel: 1,
      batchMaxCostMicrocents: 100,
    });
    expect(outcome.batchAborted).toBe(true);
    expect(outcome.overBudget).toBe(true);
  });
});

describe("parsePositiveIntEnv — malformed env caps never produce NaN (Copilot #291-2)", () => {
  const VAR = "SUBAGENT_TEST_CAP_UNSET_XYZ";

  it("returns the default when unset or blank", () => {
    delete process.env[VAR];
    expect(parsePositiveIntEnv(VAR, 6)).toBe(6);
    process.env[VAR] = "";
    expect(parsePositiveIntEnv(VAR, 6)).toBe(6);
    process.env[VAR] = "   ";
    expect(parsePositiveIntEnv(VAR, 6)).toBe(6);
    delete process.env[VAR];
  });

  it("clamps a non-numeric value to the default instead of yielding NaN", () => {
    for (const bad of ["six", "6px", "NaN", "abc", "1e"]) {
      process.env[VAR] = bad;
      const got = parsePositiveIntEnv(VAR, 6);
      expect(Number.isNaN(got)).toBe(false);
      expect(got).toBe(6);
    }
    delete process.env[VAR];
  });

  it("rejects non-integers, zero, and negatives (below the min)", () => {
    for (const bad of ["6.5", "0", "-3", "-1"]) {
      process.env[VAR] = bad;
      const got = parsePositiveIntEnv(VAR, 6);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBe(6);
    }
    delete process.env[VAR];
  });

  it("accepts a well-formed positive integer (with surrounding whitespace)", () => {
    process.env[VAR] = "8";
    expect(parsePositiveIntEnv(VAR, 6)).toBe(8);
    process.env[VAR] = "  10 ";
    expect(parsePositiveIntEnv(VAR, 6)).toBe(10);
    delete process.env[VAR];
  });

  it("honours a custom min", () => {
    process.env[VAR] = "5";
    // 5 < min 1_000_000 → falls back to the default.
    expect(parsePositiveIntEnv(VAR, 200_000_000, 1_000_000)).toBe(200_000_000);
    delete process.env[VAR];
  });
});

describe("runSubagentBatch — progress (issue #268)", () => {
  it("emits one n-of-m tick per settled spec with monotonic finished count", async () => {
    const specs = Array.from({ length: 4 }, (_, i) => spec(`r${i}`));
    const ticks: { finished: number; total: number; cost: number }[] = [];

    await runSubagentBatch(specs, async (s) => completed(s.role, 25), {
      maxParallel: 2,
      batchMaxCostMicrocents: Number.MAX_SAFE_INTEGER,
      onProgress: (p) =>
        ticks.push({ finished: p.finished, total: p.total, cost: p.totalCostMicrocents }),
    });

    expect(ticks).toHaveLength(4);
    expect(ticks.map((t) => t.finished)).toEqual([1, 2, 3, 4]);
    expect(ticks.every((t) => t.total === 4)).toBe(true);
    // Running cost accumulates monotonically to the batch total.
    expect(ticks[ticks.length - 1]?.cost).toBe(100);
  });
});
