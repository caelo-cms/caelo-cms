// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { computeAiCallCostMicrocents, worstCaseTextMicrocents } from "./call-cost.js";

describe("worstCaseTextMicrocents (#1653)", () => {
  const pricing = {
    inputMicrocents: 300,
    outputMicrocents: 1500,
    cachedMicrocents: 30,
    cacheCreationMicrocents: 375,
    longPromptThresholdTokens: null,
    longPromptMultiplier: null,
  };

  it("bills every prompt token at the dearest input lane and the whole output ceiling", () => {
    // 10,000 × 375/1K + 2,000 × 1,500/1K = 3,750 + 3,000.
    expect(worstCaseTextMicrocents(pricing, { promptTokens: 10_000, maxOutputTokens: 2_000 })).toBe(
      6_750,
    );
  });

  it("is never below the real cost of a call inside its bounds", () => {
    const real = computeAiCallCostMicrocents(pricing, {
      operationType: "text",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cachedTokens: 4_000,
      cacheCreationTokens: 6_000,
      imageCount: 0,
    }).costMicrocents;
    expect(
      worstCaseTextMicrocents(pricing, { promptTokens: 10_000, maxOutputTokens: 2_000 }),
    ).toBeGreaterThanOrEqual(real);
  });

  it("takes the prompt-length card when the bound crosses its threshold, and null without pricing", () => {
    const long = { ...pricing, longPromptThresholdTokens: 5_000, longPromptMultiplier: 2 };
    expect(worstCaseTextMicrocents(long, { promptTokens: 10_000, maxOutputTokens: 0 })).toBe(7_500);
    expect(worstCaseTextMicrocents(null, { promptTokens: 1, maxOutputTokens: 1 })).toBeNull();
  });
});
