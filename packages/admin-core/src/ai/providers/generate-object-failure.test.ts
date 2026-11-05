// SPDX-License-Identifier: MPL-2.0

/**
 * #1477 — Claude Haiku 5.5 can decline a request and has no server-side
 * fallback, and its thinking shares `max_tokens`. Neither is a schema miss:
 * callers must be able to tell them apart from "re-prompt and it may parse".
 */

import { describe, expect, it, spyOn } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runSDKGenerateObject } from "./_sdk-shared.js";

const stoppedWith = (unified: "content-filter" | "length" | "stop", raw: string) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [],
      finishReason: { unified, raw },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });

const run = (model: MockLanguageModelV3) =>
  runSDKGenerateObject({
    model,
    modelId: "claude-haiku-5-5",
    systemAndMessages: { messages: [{ role: "user", content: "x" }] },
    rawJsonSchema: { type: "object", properties: {}, additionalProperties: false },
  });

describe("runSDKGenerateObject failure reason", () => {
  it.each([
    ["content-filter", "refusal", "refused"],
    ["length", "max_tokens", "truncated"],
  ] as const)("%s reads as %s", async (unified, raw, failure) => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const result = await run(stoppedWith(unified, raw));
    log.mockRestore();
    expect(result.object).toBeUndefined();
    expect(result.failure).toBe(failure);
  });

  it("carries no reason for a plain schema miss, which stays repairable", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const result = await run(stoppedWith("stop", "end_turn"));
    log.mockRestore();
    expect(result.object).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
