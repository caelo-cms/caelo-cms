// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  computeAiCallCostMicrocents,
  IMAGE_TOKEN_BOUND,
  PROVIDER_REQUEST_OVERHEAD_TOKENS,
  promptTokenBound,
  tokenBoundOf,
  worstCaseTextMicrocents,
} from "./ai-cost.js";

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

describe("token bounds for reservations (#1653)", () => {
  it("counts every UTF-8 byte of text as at most one token", () => {
    // The JSON text's bytes: quotes included.
    expect(tokenBoundOf("abc")).toBe(5);
    // Each umlaut is two bytes, so two tokens at most.
    expect(tokenBoundOf("äö")).toBe(6);
    expect(tokenBoundOf("你好")).toBe(8);
  });

  it("counts an image part at a fixed bound instead of its base64 bytes", () => {
    const image = { type: "image", base64: "A".repeat(2_000_000), mediaType: "image/png" };
    const bound = tokenBoundOf([{ role: "user", content: "see", additionalContent: [image] }]);
    expect(bound).toBeGreaterThanOrEqual(IMAGE_TOKEN_BOUND);
    expect(bound).toBeLessThan(IMAGE_TOKEN_BOUND + 200);
    // The SDK's file/media part shapes count the same way.
    expect(
      tokenBoundOf({ type: "file", data: "B".repeat(500_000), mediaType: "application/pdf" }),
    ).toBeLessThan(IMAGE_TOKEN_BOUND + 100);
  });

  it("never counts a function (tool handlers) and adds the provider's wrapping once", () => {
    // The key travels in a schema dump at most; the function's source never does.
    expect(tokenBoundOf({ name: "t", handler: () => "x".repeat(10_000) })).toBeLessThan(40);
    expect(promptTokenBound("s", "m")).toBe(PROVIDER_REQUEST_OVERHEAD_TOKENS + 6);
  });

  it("bounds a JSON value at no less than its serialized bytes", () => {
    const value = { a: [1, 2, { b: "text", d: "Grüße\n" }], c: null, e: true };
    expect(tokenBoundOf(value)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(value)));
  });
});
