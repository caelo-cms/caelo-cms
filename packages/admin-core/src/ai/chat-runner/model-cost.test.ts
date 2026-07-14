// SPDX-License-Identifier: MPL-2.0

/**
 * The streamed usage.cost fell back to Opus-tier constants for every model —
 * a live claude-sonnet-5 turn reported ~5× its real cost
 * (run-logs/token-efficiency-analysis.md). pickModelRates converts the
 * ai_pricing row (microcents/1K) to USD/MTok so the cost matches the model.
 */

import { describe, expect, it } from "bun:test";
import { type AiPricingRow, pickModelRates } from "./model-cost.js";

const ROWS: AiPricingRow[] = [
  { provider: "anthropic", model: "claude-sonnet-5", operationType: "text", inputMicrocents: 300000, outputMicrocents: 1500000 },
  { provider: "anthropic", model: "claude-opus-4-8", operationType: "text", inputMicrocents: 500000, outputMicrocents: 2500000 },
  { provider: "anthropic", model: "*", operationType: "text", inputMicrocents: 999999, outputMicrocents: 999999 },
];

describe("pickModelRates", () => {
  it("converts sonnet-5 microcents/1K to $3/$15 per MTok", () => {
    expect(pickModelRates(ROWS, "anthropic", "claude-sonnet-5")).toEqual({
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
    });
  });

  it("exact model wins over the provider wildcard", () => {
    const r = pickModelRates(ROWS, "anthropic", "claude-opus-4-8");
    expect(r?.inputCostPerMTok).toBe(5);
    expect(r?.outputCostPerMTok).toBe(25);
  });

  it("falls back to the provider `*` wildcard for an unlisted model", () => {
    const r = pickModelRates(ROWS, "anthropic", "claude-future-9");
    expect(r?.inputCostPerMTok).toBeCloseTo(9.99999, 4);
  });

  it("returns null when no row matches (caller falls back loudly)", () => {
    expect(pickModelRates(ROWS, "openai", "gpt-x")).toBeNull();
    expect(pickModelRates([], "anthropic", "claude-sonnet-5")).toBeNull();
  });

  it("returns null when the matched row has no output rate", () => {
    expect(
      pickModelRates(
        [{ provider: "x", model: "y", operationType: "text", inputMicrocents: 1, outputMicrocents: null }],
        "x",
        "y",
      ),
    ).toBeNull();
  });
});
