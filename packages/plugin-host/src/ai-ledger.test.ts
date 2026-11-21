// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  describeAiCapRefusal,
  IMAGE_TOKEN_BOUND,
  PROVIDER_REQUEST_OVERHEAD_TOKENS,
  promptTokenBound,
  tokenBoundOf,
} from "./ai-ledger.js";

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

describe("refusal messages", () => {
  it("names the budget, the figures, what the call could cost and where to raise it", () => {
    const m = describeAiCapRefusal(
      {
        kind: "budget",
        scope: "day-global",
        operationType: "text",
        capMicrocents: 1_000_000_000,
        spentMicrocents: 990_000_000,
        requestedMicrocents: 45_000_000,
      },
      "this chat step",
    );
    expect(m).toContain("AiBudgetReached (day-global)");
    expect(m).toContain("$9.90 of $10.00 spent");
    expect(m).toContain("this chat step could cost up to $0.45");
    expect(m).toContain("propose_set_ai_budget");
  });

  it("keeps small amounts readable", () => {
    const m = describeAiCapRefusal(
      {
        kind: "plugin-budget",
        capMicrocents: 50_000,
        spentMicrocents: 40_000,
        requestedMicrocents: 15_000,
      },
      "the call",
    );
    expect(m).toContain("$0.0004 of $0.0005");
    expect(m).toContain("propose_set_plugin_ai_cost_cap");
  });

  it("says a session cap needs a chat and an uncapped visitor surface runs nothing", () => {
    expect(
      describeAiCapRefusal({ kind: "session-required", operationType: "image" }, "this image"),
    ).toContain("runs only inside a chat");
    expect(
      describeAiCapRefusal(
        { kind: "visitor-budget", capMicrocents: 0, spentMicrocents: 0, requestedMicrocents: 1 },
        "x",
      ),
    ).toContain("no daily AI budget for visitors is set");
  });
});
