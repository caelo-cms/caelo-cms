// SPDX-License-Identifier: MPL-2.0
/**
 * resolveThinkingOption — Claude 4.6+ models reject `budget_tokens`
 * with a 400 (adaptive thinking only); older models still require the
 * explicit budget form. Regression test for the Sonnet-5 default
 * switch: sending `{type: "enabled", budget_tokens}` to claude-sonnet-5
 * kills every chat turn with an API 400.
 */
import { describe, expect, it } from "bun:test";
import { isAdaptiveModel, resolveThinkingOption } from "../providers/anthropic.js";

describe("isAdaptiveModel — the class that rejects pre-4.6 sampling/thinking knobs", () => {
  it.each([
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-mythos-5",
  ])("%s is adaptive (rejects temperature + budget_tokens)", (model) => {
    expect(isAdaptiveModel(model)).toBe(true);
  });

  it.each([
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ])("%s is NOT adaptive (still accepts temperature + budget_tokens)", (model) => {
    expect(isAdaptiveModel(model)).toBe(false);
  });
});

describe("resolveThinkingOption", () => {
  it.each([
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-fable-5",
  ])("maps %s to adaptive thinking (budget_tokens would 400)", (model) => {
    expect(resolveThinkingOption(model, 4096)).toEqual({ type: "adaptive" });
  });

  it.each([
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ])("keeps the explicit budget form for %s", (model) => {
    expect(resolveThinkingOption(model, 4096)).toEqual({
      type: "enabled",
      budgetTokens: 4096,
    });
  });
});
