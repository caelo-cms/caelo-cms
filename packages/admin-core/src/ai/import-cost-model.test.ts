// SPDX-License-Identifier: MPL-2.0

/**
 * issue #298 — BACKTEST of the calls×context cost model against the
 * telemetry of runs #13/#14/#15 (`run-logs/dev-run13/14/15.log`,
 * reconstruction method in `run-logs/run15-analysis.md`).
 *
 * Ground truth (main session of each run; per-call input = the diff of the
 * cumulative per-turn `tokensIn` counter in the chat-runner loop log,
 * summed per turn segment — run #15 reproduces the analysis file's
 * 30,112,008 / 136,076 exactly):
 *
 *   run #13: 42 calls,  in 10,483,161, out  93,163
 *   run #14: 79 calls,  in 26,407,843, out 130,238
 *   run #15: 107 calls, in 30,112,008, out 136,076, 14 pages built
 *
 * Priced at Sonnet-class rates ($3/M input, $15/M output, $0.30/M cache
 * read — the rates the run15-analysis reconstruction used):
 *
 *   run #13: no-cache $32.85, 90%-cache-read $ 7.37
 *   run #14: no-cache $81.18, 90%-cache-read $17.01
 *   run #15: no-cache $92.38, 90%-cache-read $19.20  ← the "$19–$92"
 *
 * Acceptance (issue #298): the model applied to these run shapes lands
 * within 2× of the reconstructed real cost. The OLD estimator said
 * $0.28–$1.40 for run #15 (15–65× off).
 */

import { describe, expect, it } from "bun:test";
import {
  BASE_CONTEXT_TOKENS_PER_CALL,
  calibrateImportCostModel,
  deriveRunCalibration,
  estimateImportAiCost,
  estimateImportCallCount,
  estimateImportTokens,
  HISTORY_GROWTH_TOKENS_PER_CALL,
  IMPORT_CALLS_PER_PAGE,
  IMPORT_FLOW_OVERHEAD_CALLS,
  type ImportModelRates,
  inferCallCountFromTokens,
  priceImportTokens,
} from "./import-cost-model.js";

/** Sonnet-class ai_pricing rates in microcents per 1K tokens:
 *  $3/M in = 300,000µ¢/1K; $15/M out = 1,500,000; $0.30/M cache read = 30,000. */
const SONNET: ImportModelRates = {
  inputMicrocentsPer1K: 300_000,
  outputMicrocentsPer1K: 1_500_000,
  cachedInputMicrocentsPer1K: 30_000,
};

/** The reconstructions above, USD. */
const REAL = {
  run13: {
    calls: 42,
    inputTokens: 10_483_161,
    outputTokens: 93_163,
    noCache: 32.85,
    cached90: 7.37,
  },
  run14: {
    calls: 79,
    inputTokens: 26_407_843,
    outputTokens: 130_238,
    noCache: 81.18,
    cached90: 17.01,
  },
  run15: {
    calls: 107,
    inputTokens: 30_112_008,
    outputTokens: 136_076,
    noCache: 92.38,
    cached90: 19.2,
  },
} as const;

/** The 2× acceptance criterion, symmetric. */
function expectWithin2x(predicted: number, real: number): void {
  expect(predicted).toBeGreaterThanOrEqual(real / 2);
  expect(predicted).toBeLessThanOrEqual(real * 2);
}

describe("estimateImportCallCount (#298)", () => {
  it("14 pages at today's calls/page reproduces run #15's 107 calls", () => {
    // 14×7 + 9 = 107 — the constants were calibrated on exactly this run.
    expect(estimateImportCallCount(14)).toBe(107);
    expect(14 * IMPORT_CALLS_PER_PAGE + IMPORT_FLOW_OVERHEAD_CALLS).toBe(107);
  });

  it("zero pages means zero calls, and the #299 bulk constant shrinks the count", () => {
    expect(estimateImportCallCount(0)).toBe(0);
    expect(estimateImportCallCount(14, { callsPerPage: 3 })).toBe(14 * 3 + 9);
  });
});

describe("token model backtest — runs #13/#14/#15 (#298 acceptance)", () => {
  // Feed each run's OBSERVED call count through the ramp; the predicted
  // input-token total must land within 2× of the billed total.
  for (const [name, run] of Object.entries(REAL)) {
    it(`${name}: predicted tokens within 2x of the billed telemetry`, () => {
      const t = estimateImportTokens(run.calls);
      expectWithin2x(t.inputTokens, run.inputTokens);
      expectWithin2x(t.outputTokens, run.outputTokens);
    });

    it(`${name}: predicted cost band within 2x of the reconstructed real cost`, () => {
      const t = estimateImportTokens(run.calls);
      // High bound = no cache — compare against the no-cache reconstruction.
      const { highUsd } = priceImportTokens(t, SONNET);
      expectWithin2x(highUsd, run.noCache);
      // Low bound at the SAME cache assumption as the reconstruction (90%
      // cache read) — compare against the cached reconstruction.
      const { lowUsd } = priceImportTokens(t, SONNET, 0.9);
      expectWithin2x(lowUsd, run.cached90);
    });
  }
});

describe("full pipeline backtest — run #15 from its page count (#298 acceptance)", () => {
  it("14 pages price to a band within 2x of the $19-$92 reconstruction", () => {
    const est = estimateImportAiCost(14, SONNET);
    expect(est.calls).toBe(107);
    // High (no cache) vs the $92.38 no-cache reconstruction.
    expectWithin2x(est.aiCostUsd.high, REAL.run15.noCache);
    // The default-cache low bound must sit INSIDE the real band — the
    // operator's real bill was somewhere in $19–$92 depending on cache.
    expect(est.aiCostUsd.low).toBeGreaterThanOrEqual(REAL.run15.cached90);
    expect(est.aiCostUsd.low).toBeLessThanOrEqual(REAL.run15.noCache);
    // At the reconstruction's own 90% cache assumption, within 2× of $19.20.
    const t = estimateImportTokens(est.calls);
    expectWithin2x(priceImportTokens(t, SONNET, 0.9).lowUsd, REAL.run15.cached90);
  });

  it("no longer prices a 14-page migration like the old $/page heuristic", () => {
    // Old estimator: 14 × $0.02–$0.10 = $0.28–$1.40 (15–65× under).
    const est = estimateImportAiCost(14, SONNET);
    expect(est.aiCostUsd.low).toBeGreaterThan(1.4 * 10);
    expect(est.aiCostUsd.high).toBeGreaterThan(REAL.run15.noCache / 2);
  });
});

describe("pricing edge cases", () => {
  it("collapses the band when the provider prices no cache tier", () => {
    const rates: ImportModelRates = { ...SONNET, cachedInputMicrocentsPer1K: null };
    const t = estimateImportTokens(107);
    const { lowUsd, highUsd } = priceImportTokens(t, rates);
    expect(lowUsd).toBe(highUsd);
  });

  it("caps per-call input for long runs instead of growing quadratically", () => {
    // 2389 calls (a 340-page sitemap) — per-call input must not exceed the
    // observed 556K context ceiling: total < calls × cap.
    const calls = estimateImportCallCount(340);
    const t = estimateImportTokens(calls);
    expect(t.inputTokens).toBeLessThanOrEqual(calls * 556_000);
    // …but the tail must price AT the cap, not on an unbounded ramp:
    // switching the cap off would exceed this total.
    const uncapped = estimateImportTokens(calls, {
      maxContextTokensPerCall: Number.MAX_SAFE_INTEGER,
    });
    expect(uncapped.inputTokens).toBeGreaterThan(t.inputTokens);
  });
});

describe("learning loop — calibration from completed-run aggregates (#298)", () => {
  it("inverts run #15's billed input back to approximately its call count", () => {
    const inferred = inferCallCountFromTokens(REAL.run15.inputTokens);
    // 30.1M inverts to ~97 under the fixed ramp (real: 107) — the point is
    // the right order of magnitude for calls/page learning, flagged inferred.
    expectWithin2x(inferred, REAL.run15.calls);
  });

  it("derives run #15's observed calls/page from its telemetry", () => {
    const cal = deriveRunCalibration({
      turnCount: 8,
      inputTokens: REAL.run15.inputTokens,
      outputTokens: REAL.run15.outputTokens,
      pagesBuilt: 14,
      apiCalls: REAL.run15.calls,
    });
    expect(cal.callsInferred).toBe(false);
    // (107 − 9) / 14 = 7.0 — recovers IMPORT_CALLS_PER_PAGE exactly.
    expect(cal.callsPerPage).toBe(IMPORT_CALLS_PER_PAGE);
    expect(cal.meanInputTokensPerCall).toBe(Math.round(REAL.run15.inputTokens / 107));
    // Both one-dimensional projections exist and are sane: base cannot
    // exceed the observed mean; slope stays the same order as the measured
    // 4.3K/call constant.
    expect(cal.baseContextTokensPerCall).toBeGreaterThan(0);
    expect(cal.baseContextTokensPerCall!).toBeLessThan(cal.meanInputTokensPerCall!);
    expectWithin2x(cal.historyGrowthTokensPerCall!, HISTORY_GROWTH_TOKENS_PER_CALL);
  });

  it("falls back to model-inverted calls when only ai_calls aggregates exist", () => {
    const cal = deriveRunCalibration({
      turnCount: 8,
      inputTokens: REAL.run15.inputTokens,
      outputTokens: REAL.run15.outputTokens,
      pagesBuilt: 14,
    });
    expect(cal.callsInferred).toBe(true);
    expectWithin2x(cal.apiCalls, REAL.run15.calls);
    expectWithin2x(cal.callsPerPage!, IMPORT_CALLS_PER_PAGE);
  });

  it("weights the cross-run rollup by work, not by run count", () => {
    const rollup = calibrateImportCostModel([
      // A 14-page migration at 7 calls/page…
      {
        turnCount: 8,
        inputTokens: REAL.run15.inputTokens,
        outputTokens: REAL.run15.outputTokens,
        pagesBuilt: 14,
        apiCalls: 107,
      },
      // …and a 1-page pilot with heavy overhead (16 calls for 1 page).
      { turnCount: 2, inputTokens: 1_800_000, outputTokens: 20_000, pagesBuilt: 1, apiCalls: 16 },
    ]);
    expect(rollup.runsUsed).toBe(2);
    // (98 + 7) build calls / 15 pages = 7.0 — the pilot cannot drag the
    // constant to its own 7-calls-for-1-page shape alone.
    expect(rollup.callsPerPage!).toBeCloseTo((98 + 7) / 15, 5);
    expect(rollup.anyCallsInferred).toBe(false);
    expect(rollup.baseContextTokensPerCall).toBeGreaterThan(0);
  });

  it("returns nulls, not fabricated constants, when no run built pages", () => {
    const rollup = calibrateImportCostModel([
      { turnCount: 1, inputTokens: 0, outputTokens: 0, pagesBuilt: 0, apiCalls: 0 },
    ]);
    expect(rollup.callsPerPage).toBeNull();
    expect(rollup.baseContextTokensPerCall).toBeNull();
  });

  it("base context stays measurable at the documented ~103K on a fresh call", () => {
    // Loop-0 telemetry: 103,514 tokens before any history (run #15).
    expect(BASE_CONTEXT_TOKENS_PER_CALL).toBeGreaterThan(100_000);
    expect(BASE_CONTEXT_TOKENS_PER_CALL).toBeLessThan(110_000);
  });
});
