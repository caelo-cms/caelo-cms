// SPDX-License-Identifier: MPL-2.0

/**
 * issue #304 — unit tests for the wave orchestrator (`runSubagentWaves`)
 * with a MOCK spawn fn + MOCK budget fetcher (no chat-runner, no DB, no
 * provider) — same style as spawn-subagent-batch.test.ts:
 *
 *   1. Cap materialization: specs without an explicit cap get the
 *      budget-derived cap; explicit caps pass through untouched.
 *   2. Partial re-dispatch: a partial child's remainder runs again in
 *      the next wave with a continuation brief; results merge into ONE
 *      full-coverage final entry per original spec.
 *   3. No-progress guard: a remainder with zero new pages twice in a row
 *      stops loudly instead of burning a third wave.
 *   4. Between-waves budget re-check: a tripped run ceiling stops
 *      dispatch and surfaces the #297 pause text — no second pause flow.
 *   5. The maxWaves belt.
 */

import { describe, expect, it } from "bun:test";
import type { SpawnSubagentToolInput } from "@caelo-cms/shared";

import {
  type RunBudgetSnapshot,
  runSubagentWaves,
  type SubagentInvocationResult,
} from "../tools/subagent-batch.js";
import { MAX_ZERO_PROGRESS_WAVES, SUBAGENT_MAX_WAVES } from "../tools/subagent-budget.js";

function spec(role: string, extra: Partial<SpawnSubagentToolInput> = {}): SpawnSubagentToolInput {
  return {
    role,
    task: `rebuild pages for ${role}`,
    expectedReturnShape: "rebuild",
    timeoutMs: 60_000,
    ...extra,
  } as SpawnSubagentToolInput;
}

function completed(role: string, cost = 10): SubagentInvocationResult {
  return {
    role,
    status: "completed",
    resultJson: { pages: [{ slug: `${role}-page`, status: "rebuilt" }], summary: "done" },
    costMicrocents: cost,
    durationMs: 5,
    subagentChatSessionId: `sess-${role}`,
  };
}

function partial(
  role: string,
  completedSlugs: string[],
  remainingSlugs: string[],
  cost = 90,
): SubagentInvocationResult {
  return {
    role,
    status: "partial",
    resultJson: {
      pages: [
        ...completedSlugs.map((slug) => ({ slug, status: "rebuilt" })),
        ...remainingSlugs.map((slug) => ({
          slug,
          status: "skipped",
          notes: "not reached: cost cap",
        })),
      ],
      summary: "stopped at cost budget",
    },
    costMicrocents: cost,
    durationMs: 5,
    subagentChatSessionId: `sess-${role}`,
    partial: {
      completedPages: completedSlugs.map((slug) => ({ slug })),
      remainingPages: remainingSlugs.map((slug) => ({ slug, notes: "not reached: cost cap" })),
    },
  };
}

const FALLBACK_OPTS = {
  maxParallel: 4,
  fallbackChildCapMicrocents: 250,
  fallbackBatchCapMicrocents: 1_000,
  maxWaves: SUBAGENT_MAX_WAVES,
  fetchRunBudget: null,
};

function budgetOnce(
  snapshots: (RunBudgetSnapshot | null)[],
): () => Promise<RunBudgetSnapshot | null> {
  let i = 0;
  return async () => {
    const snap = snapshots[Math.min(i, snapshots.length - 1)] ?? null;
    i += 1;
    return snap;
  };
}

describe("runSubagentWaves — cap materialization (issue #304)", () => {
  it("derives per-child caps from the remaining run budget", async () => {
    const seenCaps: (number | undefined)[] = [];
    const outcome = await runSubagentWaves(
      [spec("a"), spec("b"), spec("c"), spec("d", { maxCostMicrocents: 42 })],
      async (s) => {
        seenCaps.push(s.maxCostMicrocents);
        return completed(s.role);
      },
      {
        ...FALLBACK_OPTS,
        // remaining 1.2B → batch 1.08B, per child 1.08B/4 = 270M.
        fetchRunBudget: budgetOnce([
          { remainingMicrocents: 1_200_000_000, tripped: false, pauseText: "unused" },
        ]),
      },
    );
    // Derived cap for the three open specs; the explicit 42 wins for "d".
    expect(seenCaps).toEqual([270_000_000, 270_000_000, 270_000_000, 42]);
    expect(outcome.capSource).toBe("run-budget");
    expect(outcome.waves).toBe(1);
    expect(outcome.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("uses the env fallbacks when no budget fetcher / no armed ceiling exists", async () => {
    const seenCaps: (number | undefined)[] = [];
    const outcome = await runSubagentWaves(
      [spec("a"), spec("b")],
      async (s) => {
        seenCaps.push(s.maxCostMicrocents);
        return completed(s.role, 1);
      },
      FALLBACK_OPTS,
    );
    expect(seenCaps).toEqual([250, 250]);
    expect(outcome.capSource).toBe("fallback");
    expect(outcome.budgetStopped).toBe(false);
  });
});

describe("runSubagentWaves — partial re-dispatch (issue #304)", () => {
  it("re-dispatches a partial child's remainder with a continuation brief and merges the final result", async () => {
    const calls: { role: string; task: string; originalIndex: number }[] = [];
    let bAttempts = 0;
    const outcome = await runSubagentWaves(
      [spec("a"), spec("b")],
      async (s, originalIndex) => {
        calls.push({ role: s.role, task: s.task, originalIndex });
        if (s.role !== "b") return completed(s.role, 10);
        bAttempts += 1;
        if (bAttempts === 1) return partial("b", ["b-1"], ["b-2", "b-3"], 90);
        return {
          ...completed("b", 60),
          resultJson: {
            pages: [
              { slug: "b-2", status: "rebuilt" },
              { slug: "b-3", status: "rebuilt" },
            ],
            summary: "remainder done",
          },
        };
      },
      FALLBACK_OPTS,
    );

    // Wave 0 ran both specs; wave 1 ran ONLY b's remainder.
    expect(calls.map((c) => c.role)).toEqual(["a", "b", "b"]);
    expect(outcome.waves).toBe(2);
    expect(outcome.ran).toBe(3);

    // The continuation brief names what landed and what remains, and
    // keeps the original task as ground truth.
    const retry = calls[2] as { task: string; originalIndex: number };
    expect(retry.originalIndex).toBe(1);
    expect(retry.task).toContain("CONTINUATION");
    expect(retry.task).toContain("b-1");
    expect(retry.task).toContain("- b-2");
    expect(retry.task).toContain("rebuild pages for b");

    // ONE final entry per original spec; b's merges both waves.
    expect(outcome.results).toHaveLength(2);
    const b = outcome.results[1] as SubagentInvocationResult;
    expect(b.status).toBe("completed");
    expect(b.costMicrocents).toBe(150); // 90 (wave 0) + 60 (wave 1)
    const pages = (b.resultJson as { pages: { slug: string }[] }).pages.map((p) => p.slug);
    expect(pages).toEqual(["b-1", "b-2", "b-3"]);
  });
});

describe("runSubagentWaves — no-progress guard (issue #304)", () => {
  it("stops loudly after MAX_ZERO_PROGRESS_WAVES remainder waves with zero new pages", async () => {
    let attempts = 0;
    const outcome = await runSubagentWaves(
      [spec("stuck")],
      async () => {
        attempts += 1;
        // Never completes anything: partial with an empty completed set.
        return partial("stuck", [], ["s-1", "s-2"], 90);
      },
      FALLBACK_OPTS,
    );

    expect(attempts).toBe(MAX_ZERO_PROGRESS_WAVES);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("partial");
    expect(final.errorKind).toBe("no-progress");
    expect(final.errorMessage).toContain("no progress");
    expect(final.errorMessage).toContain("s-1");
    // The spend of every attempt stays visible.
    expect(final.costMicrocents).toBe(90 * MAX_ZERO_PROGRESS_WAVES);
  });

  it("resets the streak when a wave makes progress", async () => {
    let attempts = 0;
    await runSubagentWaves(
      [spec("slow")],
      async () => {
        attempts += 1;
        if (attempts === 1) return partial("slow", [], ["s-1", "s-2"], 10); // streak 1
        if (attempts === 2) return partial("slow", ["s-1"], ["s-2"], 10); // progress → reset
        if (attempts === 3) return partial("slow", [], ["s-2"], 10); // streak 1 again
        return completed("slow", 10);
      },
      FALLBACK_OPTS,
    );
    expect(attempts).toBe(4);
  });
});

describe("runSubagentWaves — between-waves budget re-check (issue #304 / #297)", () => {
  it("stops dispatching when the run ceiling trips between waves and surfaces the #297 pause text", async () => {
    let spawns = 0;
    const outcome = await runSubagentWaves(
      [spec("a")],
      async () => {
        spawns += 1;
        return partial("a", ["a-1"], ["a-2"], 90);
      },
      {
        ...FALLBACK_OPTS,
        fetchRunBudget: budgetOnce([
          { remainingMicrocents: 500_000_000, tripped: false, pauseText: "unused" },
          { remainingMicrocents: -10, tripped: true, pauseText: "PAUSE-TEXT-297" },
        ]),
      },
    );

    // Wave 0 ran; wave 1 was never dispatched.
    expect(spawns).toBe(1);
    expect(outcome.waves).toBe(1);
    expect(outcome.budgetStopped).toBe(true);
    expect(outcome.pauseText).toBe("PAUSE-TEXT-297");

    // The pending remainder is finalized as partial — landed pages kept.
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("partial");
    expect(final.errorKind).toBe("run-budget-paused");
    expect(final.partial?.completedPages.map((p) => p.slug)).toEqual(["a-1"]);
  });

  it("refuses to dispatch wave 0 against an already-tripped ceiling", async () => {
    let spawns = 0;
    const outcome = await runSubagentWaves(
      [spec("a"), spec("b")],
      async () => {
        spawns += 1;
        return completed("x");
      },
      {
        ...FALLBACK_OPTS,
        fetchRunBudget: budgetOnce([
          { remainingMicrocents: 0, tripped: true, pauseText: "PAUSE-TEXT-297" },
        ]),
      },
    );
    expect(spawns).toBe(0);
    expect(outcome.waves).toBe(0);
    expect(outcome.budgetStopped).toBe(true);
    expect(outcome.pauseText).toBe("PAUSE-TEXT-297");
    for (const r of outcome.results) {
      expect(r.status).toBe("errored");
      expect(r.errorKind).toBe("run-budget-paused");
    }
  });
});

describe("runSubagentWaves — maxWaves belt (issue #304)", () => {
  it("stops after maxWaves dispatches even while the remainder is progressing", async () => {
    let attempts = 0;
    const outcome = await runSubagentWaves(
      [spec("longtail")],
      async () => {
        attempts += 1;
        // Always progresses by one page but never finishes.
        return partial("longtail", [`p-${attempts}`], ["p-rest"], 10);
      },
      { ...FALLBACK_OPTS, maxWaves: 2 },
    );
    expect(attempts).toBe(2);
    expect(outcome.waves).toBe(2);
    const final = outcome.results[0] as SubagentInvocationResult;
    expect(final.status).toBe("partial");
    expect(final.errorKind).toBe("wave-limit");
    expect(final.partial?.completedPages.map((p) => p.slug)).toEqual(["p-1", "p-2"]);
  });
});
