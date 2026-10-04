// SPDX-License-Identifier: MPL-2.0
/**
 * resolveThinkingOption — Claude 4.6+ models reject `budget_tokens`
 * with a 400 (adaptive thinking only); older models still require the
 * explicit budget form. Regression test for the Sonnet-5 default
 * switch: sending `{type: "enabled", budget_tokens}` to claude-sonnet-5
 * kills every chat turn with an API 400.
 */
import { describe, expect, it } from "bun:test";
import type { GenerateInput, ProviderLoopConfig } from "../provider.js";
import {
  adaptGenerateInput,
  isAdaptiveModel,
  rejectsForcedToolChoice,
  resolveThinkingOption,
} from "../providers/anthropic.js";

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

  it.each(["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"])(
    "%s is NOT adaptive (still accepts temperature + budget_tokens)",
    (model) => {
      expect(isAdaptiveModel(model)).toBe(false);
    },
  );
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

  it.each(["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"])(
    "keeps the explicit budget form for %s",
    (model) => {
      expect(resolveThinkingOption(model, 4096)).toEqual({
        type: "enabled",
        budgetTokens: 4096,
      });
    },
  );
});

describe("5.5 generation — opus-5 is adaptive, forced tool choice is dropped", () => {
  it.each(["claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])(
    "%s is adaptive",
    (model) => {
      expect(isAdaptiveModel(model)).toBe(true);
    },
  );

  it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"])(
    "%s rejects forced tool choice",
    (model) => {
      expect(rejectsForcedToolChoice(model)).toBe(true);
    },
  );

  it.each(["claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-haiku-4-5"])(
    "%s still accepts forced tool choice",
    (model) => {
      expect(rejectsForcedToolChoice(model)).toBe(false);
    },
  );

  const baseInput = (overrides: Partial<GenerateInput> = {}): GenerateInput => ({
    systemPrompt: "s",
    messages: [],
    ...overrides,
  });
  const loopWith = (override: Awaited<ReturnType<ProviderLoopConfig["prepareStep"]>>) =>
    ({
      prepareStep: async () => override,
      onStepFinish: async () => {},
      stopWhen: () => false,
    }) as unknown as ProviderLoopConfig;
  const step = { stepIndex: 0, steps: [] };

  it("RECOVER's forced first step becomes auto on Sonnet 5.5 (regression: 400 on tool_choice any)", async () => {
    const adapted = adaptGenerateInput(
      "claude-sonnet-5-5",
      baseInput({ toolChoice: "required", loop: loopWith({ toolChoice: "required" }) }),
    );
    expect(adapted.toolChoice).toBeUndefined();
    expect(await adapted.loop?.prepareStep(step)).toBeUndefined();
  });

  it("keeps a messages override while dropping the forced choice", async () => {
    const messages = [{ role: "user", content: "x" }] as unknown as GenerateInput["messages"];
    const adapted = adaptGenerateInput(
      "claude-opus-5-5",
      baseInput({ loop: loopWith({ messages, toolChoice: "required" }) }),
    );
    expect(await adapted.loop?.prepareStep(step)).toEqual({ messages });
  });

  it("leaves models that accept forced tool choice untouched", async () => {
    const input = baseInput({ toolChoice: "required", loop: loopWith({ toolChoice: "required" }) });
    const adapted = adaptGenerateInput("claude-opus-4-8", input);
    expect(adapted.toolChoice).toBe("required");
    expect(await adapted.loop?.prepareStep(step)).toEqual({ toolChoice: "required" });
  });
});
