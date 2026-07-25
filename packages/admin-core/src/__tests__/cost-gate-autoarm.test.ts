// SPDX-License-Identifier: MPL-2.0

/**
 * issue #297 — unit coverage for the auto-armed cost gate's pure logic:
 * ceiling derivation from the approved estimate (band → high × safety
 * factor, failed-estimate refusal, representable-minimum guard), the
 * 80%/100% live-gate thresholds, the ai_calls cost mapping whose silent
 * $0 was run #14's report bug, and the operator-facing gate messages.
 * No DB here — the roll-up SQL and the approve path are covered by
 * import-cost-gate.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { computeAiCallCostMicrocents } from "../ai/call-cost.js";
import {
  type BudgetGateState,
  budgetTripText,
  budgetWarningText,
  evaluateGateLevel,
} from "../ai/chat-runner/budget-gate.js";
import { type PricingCandidate, pickPricingRow } from "../ai/pricing-cache.js";
import {
  deriveCeilingFromEstimate,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  evaluateBudgetGate,
  MICROCENTS_PER_MAJOR_UNIT,
} from "../ops/imports-cost.js";

describe("deriveCeilingFromEstimate (band → auto-armed ceiling)", () => {
  it("arms high × safety factor, in USD microcents", () => {
    const d = deriveCeilingFromEstimate({
      pages: 14,
      basis: "list",
      truncated: false,
      crawlMinutes: 1,
      aiCostUsd: { low: 0.28, high: 1.4 },
    });
    if (!d.ok) throw new Error(`expected ok, got: ${d.reason}`);
    // Ceiling = the estimate high (factor 1 — the ceiling IS the approved
    // maximum, not a multiple of it). $1.40 band high → $1.40 ceiling.
    expect(ESTIMATE_CEILING_SAFETY_FACTOR).toBe(1);
    expect(d.ceilingMicrocents).toBe(Math.round(1.4 * 1 * MICROCENTS_PER_MAJOR_UNIT));
    expect(d.currency).toBe("USD");
    expect(d.estimateHighUsd).toBe(1.4);
  });

  it("refuses a failed estimate — the operator must set the budget", () => {
    const d = deriveCeilingFromEstimate({ failed: true, reason: "no sitemap" });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toContain("FAILED");
  });

  it("refuses estimates without a usable cost band", () => {
    expect(deriveCeilingFromEstimate({ pages: 3, basis: "list" }).ok).toBe(false);
    expect(deriveCeilingFromEstimate({ aiCostUsd: { high: "5" } }).ok).toBe(false);
    expect(deriveCeilingFromEstimate({ aiCostUsd: { high: Number.NaN } }).ok).toBe(false);
    expect(deriveCeilingFromEstimate("garbage").ok).toBe(false);
    expect(deriveCeilingFromEstimate(null).ok).toBe(false);
  });

  it("enforces the representable minimum — a $0 band cannot arm a 0µ¢ ceiling", () => {
    const d = deriveCeilingFromEstimate({
      pages: 0,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 1,
      aiCostUsd: { low: 0, high: 0 },
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.reason).toContain("zero");
  });

  it("keeps a tiny-but-representable band armable", () => {
    // high = 1e-8 USD → 1µ¢ at factor 1: small, silly, but storable and honest.
    const d = deriveCeilingFromEstimate({ aiCostUsd: { low: 0, high: 1e-8 } });
    if (!d.ok) throw new Error(`expected ok, got: ${d.reason}`);
    expect(d.ceilingMicrocents).toBe(1);
  });
});

describe("evaluateBudgetGate (80% warn / 100% trip)", () => {
  const ceilingMicrocents = 1_000;

  it("is ok strictly below 80%", () => {
    expect(evaluateBudgetGate({ spentMicrocents: 799, ceilingMicrocents }).level).toBe("ok");
  });

  it("warns at exactly 80% (integer math, no float drift)", () => {
    expect(evaluateBudgetGate({ spentMicrocents: 800, ceilingMicrocents }).level).toBe("warn");
    expect(evaluateBudgetGate({ spentMicrocents: 999, ceilingMicrocents }).level).toBe("warn");
  });

  it("trips at exactly the ceiling and beyond", () => {
    expect(evaluateBudgetGate({ spentMicrocents: 1_000, ceilingMicrocents }).level).toBe("trip");
    expect(evaluateBudgetGate({ spentMicrocents: 50_000, ceilingMicrocents }).level).toBe("trip");
  });

  it("reports the fraction used for display", () => {
    expect(
      evaluateBudgetGate({ spentMicrocents: 500, ceilingMicrocents }).fractionUsed,
    ).toBeCloseTo(0.5, 10);
  });
});

describe("computeAiCallCostMicrocents (run #14 $0.00 regression)", () => {
  // claude-sonnet-5 STANDARD rates: µ¢ per 1K tokens (cache-write = 1.25x in).
  const sonnet5 = {
    inputMicrocents: 300_000,
    outputMicrocents: 1_500_000,
    cachedMicrocents: 30_000,
    cacheCreationMicrocents: 375_000,
  };

  it("prices a text call: billed input + cache reads + output", () => {
    const r = computeAiCallCostMicrocents(sonnet5, {
      operationType: "text",
      inputTokens: 110_000,
      cachedTokens: 100_000,
      cacheCreationTokens: 0,
      outputTokens: 2_000,
      imageCount: 0,
    });
    // 10K uncached + 100K cached + 2K output, all per-1K rates.
    expect(r.costMicrocents).toBe(
      Math.round(
        (10_000 * 300_000) / 1000 + (100_000 * 30_000) / 1000 + (2_000 * 1_500_000) / 1000,
      ),
    );
    expect(r.unpriced).toBe(false);
  });

  it("prices cache WRITES at the cache-creation rate, subtracted from billed input", () => {
    // SDK `inputTokens` is the grand total: 110K = 8K fresh + 100K cache-read
    // + 2K cache-write. Fresh bills at input rate, cache-read at cache rate,
    // cache-write at the cache-creation rate — no lane double-billed.
    const r = computeAiCallCostMicrocents(sonnet5, {
      operationType: "text",
      inputTokens: 110_000,
      cachedTokens: 100_000,
      cacheCreationTokens: 2_000,
      outputTokens: 500,
      imageCount: 0,
    });
    expect(r.costMicrocents).toBe(
      Math.round(
        (8_000 * 300_000) / 1000 +
          (100_000 * 30_000) / 1000 +
          (2_000 * 375_000) / 1000 +
          (500 * 1_500_000) / 1000,
      ),
    );
    expect(r.unpriced).toBe(false);
  });

  it("defaults the cache-write rate to 1.25x input when the row omits it", () => {
    const r = computeAiCallCostMicrocents(
      {
        inputMicrocents: 300_000,
        outputMicrocents: null,
        cachedMicrocents: null,
        cacheCreationMicrocents: null,
      },
      {
        operationType: "text",
        inputTokens: 5_000,
        cachedTokens: 0,
        cacheCreationTokens: 1_000,
        outputTokens: 0,
        imageCount: 0,
      },
    );
    // 4K fresh @300000 + 1K cache-write @ (300000 * 1.25 = 375000).
    expect(r.costMicrocents).toBe(Math.round((4_000 * 300_000) / 1000 + (1_000 * 375_000) / 1000));
  });

  it("run #14 shape: pricing miss + real tokens → cost 0 but FLAGGED unpriced", () => {
    const r = computeAiCallCostMicrocents(null, {
      operationType: "text",
      inputTokens: 110_000,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1_500,
      imageCount: 0,
    });
    expect(r.costMicrocents).toBe(0);
    expect(r.unpriced).toBe(true);
  });

  it("a zero-work call with no pricing is NOT flagged (nothing understated)", () => {
    const r = computeAiCallCostMicrocents(null, {
      operationType: "text",
      inputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      imageCount: 0,
    });
    expect(r.unpriced).toBe(false);
  });

  it("cached tokens bill at the input rate when the row has no cache rate", () => {
    const r = computeAiCallCostMicrocents(
      {
        inputMicrocents: 300_000,
        outputMicrocents: 1_500_000,
        cachedMicrocents: null,
        cacheCreationMicrocents: null,
      },
      {
        operationType: "text",
        inputTokens: 2_000,
        cachedTokens: 1_000,
        cacheCreationTokens: 0,
        outputTokens: 0,
        imageCount: 0,
      },
    );
    expect(r.costMicrocents).toBe(Math.round((2_000 * 300_000) / 1000));
  });

  it("prices image calls per image", () => {
    const r = computeAiCallCostMicrocents(
      {
        inputMicrocents: 4_000_000,
        outputMicrocents: null,
        cachedMicrocents: null,
        cacheCreationMicrocents: null,
      },
      {
        operationType: "image",
        inputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        imageCount: 3,
      },
    );
    expect(r.costMicrocents).toBe(12_000_000);
    expect(r.unpriced).toBe(false);
  });
});

describe("pickPricingRow (validity-dated Sonnet-5 intro vs standard)", () => {
  const ms = (iso: string) => Date.parse(iso);
  // The three ai_pricing rows migration 0186 leaves for claude-sonnet-5:
  //   - undated back-compat row (from 0155),
  //   - intro window (through 2026-08-31),
  //   - standard window (from 2026-09-01).
  const undated: PricingCandidate = {
    model: "claude-sonnet-5",
    inputMicrocents: 300_000,
    outputMicrocents: 1_500_000,
    cachedMicrocents: 30_000,
    cacheCreationMicrocents: 375_000,
    effectiveFromMs: ms("2026-06-01T00:00:00Z"),
    validFromMs: null,
    validToMs: null,
  };
  const intro: PricingCandidate = {
    model: "claude-sonnet-5",
    inputMicrocents: 200_000,
    outputMicrocents: 1_000_000,
    cachedMicrocents: 20_000,
    cacheCreationMicrocents: 250_000,
    effectiveFromMs: ms("2026-07-01T00:00:00Z"),
    validFromMs: null,
    validToMs: ms("2026-08-31T23:59:59Z"),
  };
  const standard: PricingCandidate = {
    model: "claude-sonnet-5",
    inputMicrocents: 300_000,
    outputMicrocents: 1_500_000,
    cachedMicrocents: 30_000,
    cacheCreationMicrocents: 375_000,
    effectiveFromMs: ms("2026-09-01T00:00:00Z"),
    validFromMs: ms("2026-09-01T00:00:00Z"),
    validToMs: null,
  };
  const rows = [undated, intro, standard];

  it("picks the intro row during the intro window (dated beats undated)", () => {
    const r = pickPricingRow(rows, "claude-sonnet-5", ms("2026-07-23T12:00:00Z"));
    expect(r?.inputMicrocents).toBe(200_000);
    expect(r?.cacheCreationMicrocents).toBe(250_000);
  });

  it("picks the standard row after the intro window closes", () => {
    const r = pickPricingRow(rows, "claude-sonnet-5", ms("2026-09-15T00:00:00Z"));
    // intro is excluded (valid_to passed); standard's later valid_from beats
    // the undated back-compat row.
    expect(r?.inputMicrocents).toBe(300_000);
    expect(r?.cacheCreationMicrocents).toBe(375_000);
  });

  it("falls back to the undated row when only it is dated-eligible", () => {
    // A call time before the standard window opens but after intro closes is
    // impossible for these seeds (intro valid_to = standard valid_from - 1s),
    // so prove the undated fallback with a row set that has no dated match.
    const r = pickPricingRow([undated], "claude-sonnet-5", ms("2027-01-01T00:00:00Z"));
    expect(r?.inputMicrocents).toBe(300_000);
  });

  it("returns null when no row's effective_from has passed yet", () => {
    expect(pickPricingRow([standard], "claude-sonnet-5", ms("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("prefers an exact-model row over the wildcard fallback", () => {
    const wildcard: PricingCandidate = {
      ...undated,
      model: "*",
      inputMicrocents: 999_000,
    };
    const r = pickPricingRow([wildcard, intro], "claude-sonnet-5", ms("2026-07-23T00:00:00Z"));
    expect(r?.inputMicrocents).toBe(200_000);
  });
});

describe("gate messages (operator-facing, wording-locked substrings)", () => {
  const gate: BudgetGateState = {
    runId: "00000000-0000-0000-0000-000000000001",
    ceilingMicrocents: 4.2 * MICROCENTS_PER_MAJOR_UNIT,
    ceilingCurrency: "USD",
    spentMicrocents: 4 * MICROCENTS_PER_MAJOR_UNIT,
    callCount: 42,
    unpricedCallCount: 0,
    estimateLowUsd: 0.28,
    estimateHighUsd: 1.4,
    warningEmitted: false,
    tripped: false,
  };

  it("evaluateGateLevel folds the current turn's in-memory spend on top of the roll-up", () => {
    const { level, liveSpentMicrocents } = evaluateGateLevel(gate, 0.3 * MICROCENTS_PER_MAJOR_UNIT);
    expect(liveSpentMicrocents).toBe(4.3 * MICROCENTS_PER_MAJOR_UNIT);
    expect(level).toBe("trip");
    expect(evaluateGateLevel(gate, 0).level).toBe("warn"); // 4.00 / 4.20 ≈ 95%
  });

  it("the warning names spend, ceiling, and the raise path", () => {
    const s = budgetWarningText(gate, gate.spentMicrocents);
    expect(s).toContain("$4.00");
    expect(s).toContain("$4.20");
    expect(s).toContain("set_migration_budget");
  });

  it("the pause message states real spend vs the approved estimate and how to resume", () => {
    const s = budgetTripText(gate, 4.2 * MICROCENTS_PER_MAJOR_UNIT);
    expect(s).toContain("Cost ceiling reached");
    expect(s).toContain("$4.20");
    expect(s).toContain("$0.28–$1.4"); // estimate band restated
    expect(s).toContain('say "continue"');
    expect(s).not.toContain("pricing configured"); // no false alarm when all calls priced
  });

  it("both messages flag understated spend when calls are unpriced", () => {
    const understated = { ...gate, unpricedCallCount: 3 };
    expect(budgetWarningText(understated, gate.spentMicrocents)).toContain("3 AI call(s)");
    expect(budgetTripText(understated, gate.spentMicrocents)).toContain("HIGHER");
  });
});
