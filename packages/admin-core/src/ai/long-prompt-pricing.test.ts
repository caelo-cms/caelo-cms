// SPDX-License-Identifier: MPL-2.0

/**
 * #1477 — Claude Haiku 5.5 bills a prompt over 100,000 tokens at five times its
 * normal rates. Budget caps read the recorded cost, so a row that carried only
 * the low card would let a long prompt spend five times the cap.
 */

import { describe, expect, it } from "bun:test";
import { computeAiCallCostMicrocents } from "./call-cost.js";
import { pickModelRates } from "./chat-runner/model-cost.js";
import { estimateImportAiCost } from "./import-cost-model.js";
import { longPromptRateMultiplier } from "./long-prompt-pricing.js";
import { type PricingCandidate, pickPricingRow } from "./pricing-cache.js";

// The row migration 0637 seeds.
const haiku55 = {
  inputMicrocents: 10_000,
  outputMicrocents: 50_000,
  cachedMicrocents: 1_000,
  cacheCreationMicrocents: 12_500,
  longPromptThresholdTokens: 100_000,
  longPromptMultiplier: 5,
};

const call = (inputTokens: number, extra: { largestPromptTokens?: number } = {}) => ({
  operationType: "text" as const,
  inputTokens,
  outputTokens: 1_000,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  imageCount: 0,
  ...extra,
});

describe("longPromptRateMultiplier", () => {
  it("is 1 at exactly the threshold and the multiplier one token over it", () => {
    expect(longPromptRateMultiplier(haiku55, 100_000)).toBe(1);
    expect(longPromptRateMultiplier(haiku55, 100_001)).toBe(5);
  });

  it("is 1 for a row without prompt-length pricing", () => {
    expect(longPromptRateMultiplier({}, 900_000)).toBe(1);
    expect(longPromptRateMultiplier(null, 900_000)).toBe(1);
    expect(
      longPromptRateMultiplier(
        { longPromptThresholdTokens: null, longPromptMultiplier: null },
        900_000,
      ),
    ).toBe(1);
  });
});

describe("computeAiCallCostMicrocents with prompt-length pricing", () => {
  it("bills a prompt at the threshold on the list prices: $0.10 input, $0.50 output per MTok", () => {
    // 100K * $0.10/M = $0.01 = 1,000,000 µ¢; 1K * $0.50/M = $0.0005 = 50,000 µ¢.
    expect(computeAiCallCostMicrocents(haiku55, call(100_000)).costMicrocents).toBe(1_050_000);
  });

  it("bills every lane at 5x over the threshold, cached tokens counting towards it", () => {
    const r = computeAiCallCostMicrocents(haiku55, {
      ...call(150_000),
      cachedTokens: 120_000,
      cacheCreationTokens: 20_000,
    });
    // 10K fresh at $0.50, 120K read at $0.05, 20K write at $0.625, 1K out at $2.50 per MTok.
    expect(r.costMicrocents).toBe(500_000 + 600_000 + 1_250_000 + 250_000);
  });

  it("prices a turn by its longest request, not by the sum of its requests", () => {
    const threeShortSteps = call(240_000, { largestPromptTokens: 80_000 });
    expect(computeAiCallCostMicrocents(haiku55, threeShortSteps).costMicrocents).toBe(
      2_400_000 + 50_000,
    );
  });

  it("takes the long card for the whole turn once one request crossed the threshold", () => {
    const crossed = call(240_000, { largestPromptTokens: 120_000 });
    expect(computeAiCallCostMicrocents(haiku55, crossed).costMicrocents).toBe(12_000_000 + 250_000);
  });

  it("errs high when a caller that sums requests does not say the longest one", () => {
    expect(computeAiCallCostMicrocents(haiku55, call(240_000)).costMicrocents).toBe(
      12_000_000 + 250_000,
    );
  });

  it("leaves a row without prompt-length pricing untouched at any size", () => {
    const { longPromptThresholdTokens: _t, longPromptMultiplier: _m, ...flat } = haiku55;
    expect(computeAiCallCostMicrocents(flat, call(500_000)).costMicrocents).toBe(
      5_000_000 + 50_000,
    );
  });
});

describe("the row reaches every reader", () => {
  it("pickPricingRow keeps the prompt-length fields", () => {
    const candidate: PricingCandidate = {
      ...haiku55,
      model: "claude-haiku-5-5",
      effectiveFromMs: 0,
      validFromMs: null,
      validToMs: null,
    };
    expect(pickPricingRow([candidate], "claude-haiku-5-5", 1)?.longPromptMultiplier).toBe(5);
  });

  it("pickModelRates hands them to the budget gate", () => {
    const rates = pickModelRates(
      [{ ...haiku55, provider: "anthropic", model: "claude-haiku-5-5", operationType: "text" }],
      "anthropic",
      "claude-haiku-5-5",
    );
    expect(rates?.longPrompt.longPromptThresholdTokens).toBe(100_000);
  });
});

describe("estimateImportAiCost with prompt-length pricing", () => {
  const rates = {
    inputMicrocentsPer1K: haiku55.inputMicrocents,
    outputMicrocentsPer1K: haiku55.outputMicrocents,
    cachedInputMicrocentsPer1K: haiku55.cachedMicrocents,
  };

  it("prices a migration on the long card: its prompts start above the threshold", () => {
    const flat = estimateImportAiCost(14, rates);
    const tiered = estimateImportAiCost(14, {
      ...rates,
      longPromptThresholdTokens: haiku55.longPromptThresholdTokens,
      longPromptMultiplier: haiku55.longPromptMultiplier,
    });
    expect(tiered.aiCostUsd.high).toBeCloseTo(flat.aiCostUsd.high * 5, 0);
  });

  it("stays on the short card when no prompt of the run reaches the threshold", () => {
    const params = { baseContextTokensPerCall: 1_000, maxContextTokensPerCall: 2_000 };
    const flat = estimateImportAiCost(1, rates, params);
    const tiered = estimateImportAiCost(
      1,
      {
        ...rates,
        longPromptThresholdTokens: haiku55.longPromptThresholdTokens,
        longPromptMultiplier: haiku55.longPromptMultiplier,
      },
      params,
    );
    expect(tiered.aiCostUsd).toEqual(flat.aiCostUsd);
  });
});
