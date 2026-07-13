// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 R1 — unit tests for the model-aware output-token default.
 * Adaptive-thinking models share `max_tokens` with thinking; run #8 saw
 * orchestrator turns end EMPTY at exactly output_tokens=16384. The
 * default for that model class is now 32768, env-tunable.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT,
  MAX_OUTPUT_TOKENS_DEFAULT,
  resolveMaxOutputTokensDefault,
} from "./limits.js";

const ENV_KEY = "CAELO_MAX_OUTPUT_TOKENS_DEFAULT";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveMaxOutputTokensDefault (run #8 R1)", () => {
  it("returns 32768 for adaptive-thinking-class Claude models", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]) {
      expect(resolveMaxOutputTokensDefault(model)).toBe(MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT);
    }
  });

  it("keeps 16384 for models outside the adaptive-thinking class", () => {
    for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "gpt-4o", "gemini-2.5-pro"]) {
      expect(resolveMaxOutputTokensDefault(model)).toBe(MAX_OUTPUT_TOKENS_DEFAULT);
    }
  });

  it("honours a valid CAELO_MAX_OUTPUT_TOKENS_DEFAULT override for every model", () => {
    process.env[ENV_KEY] = "49152";
    expect(resolveMaxOutputTokensDefault("claude-sonnet-5")).toBe(49152);
    expect(resolveMaxOutputTokensDefault("claude-haiku-4-5")).toBe(49152);
  });

  it("ignores garbage / too-small env values and logs instead of silently misconfiguring", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(resolveMaxOutputTokensDefault("claude-sonnet-5")).toBe(
      MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT,
    );
    process.env[ENV_KEY] = "12";
    expect(resolveMaxOutputTokensDefault("claude-sonnet-5")).toBe(
      MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT,
    );
  });
});
