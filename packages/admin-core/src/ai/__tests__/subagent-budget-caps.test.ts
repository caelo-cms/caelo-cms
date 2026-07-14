// SPDX-License-Identifier: MPL-2.0

/**
 * issue #304 — unit tests for the budget-derived subagent cap math and
 * the partial-completion contract (pure functions, no DB/provider).
 *
 *   - deriveChildCaps: the clamp formula, edge cases (no ceiling armed,
 *     tiny remainder, many children, exhausted budget).
 *   - shouldWrapUpAtCap: exact 85% integer boundary.
 *   - extractRebuildPartial / classifyChildCompletion: when a submitted
 *     result classifies as partial vs completed.
 *   - buildRemainderTask / mergeRebuildPages: the re-dispatch brief and
 *     the cross-wave result merge.
 *   - shared schema: optional per-spec cap + the max(32) batch bound
 *     matching the advertised provider schema (#251 drift class).
 */

import { describe, expect, it } from "bun:test";
import { spawnSubagentsToolInput, spawnSubagentToolInput } from "@caelo-cms/shared";

import {
  buildRemainderTask,
  CHILD_BUDGET_SHARE,
  classifyChildCompletion,
  deriveChildCaps,
  extractRebuildPartial,
  MIN_CHILD_CAP_MICROCENTS,
  mergeRebuildPages,
  shouldWrapUpAtCap,
} from "../tools/subagent-budget.js";

const FALLBACKS = {
  fallbackChildCapMicrocents: 250_000_000,
  fallbackBatchCapMicrocents: 1_000_000_000,
};

describe("deriveChildCaps — the #304 clamp formula", () => {
  it("uses the env fallbacks when no run ceiling is armed", () => {
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: null,
      plannedChildren: 8,
      ...FALLBACKS,
    });
    expect(caps).toEqual({
      perChildCapMicrocents: 250_000_000,
      batchCapMicrocents: 1_000_000_000,
      source: "fallback",
    });
  });

  it("derives child_cap = remaining × share / children in the normal case", () => {
    // The doc-comment worked example: $4.20 ceiling, $0.20 spent →
    // remaining 400M µ¢; 3 children → 400M × 0.9 / 3 = 120M µ¢ — inside
    // the run #14/#15 empirical band (90–167M) where the old 50M
    // constant failed every child.
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: 400_000_000,
      plannedChildren: 3,
      ...FALLBACKS,
    });
    expect(caps.source).toBe("run-budget");
    expect(caps.batchCapMicrocents).toBe(360_000_000);
    expect(caps.perChildCapMicrocents).toBe(120_000_000);
  });

  it("clamps a many-children starvation cap UP to the empirical floor", () => {
    // 32 children over a $20 remainder: raw share is 2B×0.9/32 = 56.25M —
    // below what ONE page-batch child empirically costs. The MIN clamp
    // lifts it to $1.00; children that need more wrap up partial and the
    // remainder rolls into the next wave.
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: 2_000_000_000,
      plannedChildren: 32,
      ...FALLBACKS,
    });
    expect(caps.perChildCapMicrocents).toBe(MIN_CHILD_CAP_MICROCENTS);
  });

  it("never promises a child more than the remaining budget (tiny remainder)", () => {
    // remaining 50M < MIN_CHILD_CAP: the upper clamp wins over the floor.
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: 50_000_000,
      plannedChildren: 4,
      ...FALLBACKS,
    });
    expect(caps.perChildCapMicrocents).toBe(50_000_000);
    expect(caps.batchCapMicrocents).toBe(Math.floor(50_000_000 * CHILD_BUDGET_SHARE));
  });

  it("returns zero caps for an exhausted or overrun budget", () => {
    for (const remaining of [0, -125_000_000]) {
      const caps = deriveChildCaps({
        remainingRunBudgetMicrocents: remaining,
        plannedChildren: 2,
        ...FALLBACKS,
      });
      expect(caps.perChildCapMicrocents).toBe(0);
      expect(caps.batchCapMicrocents).toBe(0);
      expect(caps.source).toBe("run-budget");
    }
  });

  it("floors fractional microcents (integer money math)", () => {
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: 1_000_000_001,
      plannedChildren: 3,
      ...FALLBACKS,
    });
    expect(Number.isInteger(caps.perChildCapMicrocents)).toBe(true);
    expect(Number.isInteger(caps.batchCapMicrocents)).toBe(true);
  });
});

describe("shouldWrapUpAtCap — exact 85% boundary", () => {
  it("fires at exactly 85% and above, not below", () => {
    const cap = 100_000_000;
    expect(shouldWrapUpAtCap(84_999_999, cap)).toBe(false);
    expect(shouldWrapUpAtCap(85_000_000, cap)).toBe(true);
    expect(shouldWrapUpAtCap(cap, cap)).toBe(true);
    expect(shouldWrapUpAtCap(cap + 1, cap)).toBe(true);
  });
});

const rebuildResult = {
  pages: [
    { slug: "home", status: "rebuilt" },
    { slug: "pricing", status: "rebuilt", notes: "table simplified" },
    { slug: "about", status: "skipped", notes: "not reached: cost cap" },
    { slug: "team", status: "failed", notes: "template missing" },
  ],
  contentNotes: [],
  skipped: [],
  summary: "2 of 4 done",
};

describe("extractRebuildPartial", () => {
  it("splits a rebuild result into completed vs remaining pages", () => {
    const partial = extractRebuildPartial(rebuildResult);
    expect(partial).not.toBeNull();
    expect(partial?.completedPages.map((p) => p.slug)).toEqual(["home", "pricing"]);
    expect(partial?.remainingPages.map((p) => p.slug)).toEqual(["about", "team"]);
    expect(partial?.remainingPages[0]?.notes).toBe("not reached: cost cap");
  });

  it("returns null for non-rebuild shapes (no page decomposition)", () => {
    expect(extractRebuildPartial({ pass: true, issues: [] })).toBeNull();
    expect(extractRebuildPartial({ text: "prose" })).toBeNull();
    expect(extractRebuildPartial(null)).toBeNull();
    expect(extractRebuildPartial("just text")).toBeNull();
  });
});

describe("classifyChildCompletion — the partial-result contract", () => {
  const cap = 100_000_000;

  it("stays completed below the wrap-up line even with unfinished pages", () => {
    // A cheap child that skipped pages made an editorial call — its skip
    // reasons go to the parent verbatim; re-dispatch would re-litigate.
    const cls = classifyChildCompletion({
      costMicrocents: 40_000_000,
      capMicrocents: cap,
      resultJson: rebuildResult,
    });
    expect(cls.status).toBe("completed");
  });

  it("classifies partial at ≥85% of cap with a rebuild remainder", () => {
    const cls = classifyChildCompletion({
      costMicrocents: 90_000_000,
      capMicrocents: cap,
      resultJson: rebuildResult,
    });
    expect(cls.status).toBe("partial");
    expect(cls.partial?.completedPages.map((p) => p.slug)).toEqual(["home", "pricing"]);
    expect(cls.partial?.remainingPages.map((p) => p.slug)).toEqual(["about", "team"]);
  });

  it("stays completed when everything was rebuilt, whatever the spend", () => {
    const cls = classifyChildCompletion({
      costMicrocents: 99_000_000,
      capMicrocents: cap,
      resultJson: {
        pages: [{ slug: "home", status: "rebuilt" }],
        contentNotes: [],
        skipped: [],
        summary: "",
      },
    });
    expect(cls.status).toBe("completed");
  });

  it("stays completed for non-rebuild shapes at any spend (nothing to re-dispatch)", () => {
    const cls = classifyChildCompletion({
      costMicrocents: 120_000_000,
      capMicrocents: cap,
      resultJson: { pass: true, issues: [], suggestions: [] },
    });
    expect(cls.status).toBe("completed");
  });
});

describe("buildRemainderTask", () => {
  it("carries completed pages, remaining pages with notes, and the original task", () => {
    const task = buildRemainderTask({
      originalTask: "Rebuild the marketing cluster. Ground truth at https://example.com.",
      completedPages: [{ slug: "home" }, { slug: "pricing" }],
      remainingPages: [{ slug: "about", notes: "not reached: cost cap" }],
      wave: 0,
    });
    expect(task).toContain("CONTINUATION (pass 1)");
    expect(task).toContain("home, pricing");
    expect(task).toContain("- about (previous attempt noted: not reached: cost cap)");
    expect(task).toContain("ORIGINAL TASK");
    expect(task).toContain("https://example.com");
  });
});

describe("mergeRebuildPages", () => {
  it("prepends earlier-wave rebuilt pages, deduped by slug (latest wins)", () => {
    const merged = mergeRebuildPages([{ slug: "home" }, { slug: "about" }], {
      pages: [
        { slug: "about", status: "rebuilt", notes: "finished on retry" },
        { slug: "team", status: "rebuilt" },
      ],
      summary: "remainder done",
    }) as { pages: { slug: string; status: string; notes?: string }[] };
    expect(merged.pages.map((p) => p.slug)).toEqual(["home", "about", "team"]);
    // The remainder attempt's row for "about" won over the carried ref.
    expect(merged.pages.find((p) => p.slug === "about")?.notes).toBe("finished on retry");
  });

  it("passes non-rebuild results through untouched", () => {
    const verdict = { pass: true, issues: [] };
    expect(mergeRebuildPages([{ slug: "home" }], verdict)).toBe(verdict);
    expect(mergeRebuildPages([], rebuildResult)).toBe(rebuildResult);
  });
});

describe("shared spawn schemas (issue #304)", () => {
  it("maxCostMicrocents is optional — omitted means 'derive from budget'", () => {
    const parsed = spawnSubagentToolInput.parse({ role: "builder", task: "build page X" });
    expect(parsed.maxCostMicrocents).toBeUndefined();
  });

  it("accepts the full 32-spec batch the provider schema advertises (#251 drift fix)", () => {
    const specs = Array.from({ length: 32 }, (_, i) => ({ role: `r${i}`, task: `page ${i}` }));
    expect(spawnSubagentsToolInput.safeParse({ subagents: specs }).success).toBe(true);
    expect(
      spawnSubagentsToolInput.safeParse({
        subagents: [...specs, { role: "r32", task: "page 32" }],
      }).success,
    ).toBe(false);
  });
});
