// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { AI_DELEGATED_PREFIX, delegatedProvider } from "./delegated-provider.js";
import type { AIProvider } from "./provider.js";

/** A provider that records whether it was ever asked to generate. */
function spyProvider(): AIProvider & { calls: number } {
  const p = {
    name: "anthropic" as AIProvider["name"],
    model: "spy-model",
    calls: 0,
    async *generate() {
      p.calls += 1;
      yield* [];
    },
    async generateObject() {
      p.calls += 1;
      return { object: {}, inputTokens: 1, outputTokens: 1, model: "spy-model" };
    },
  };
  return p;
}

describe("delegatedProvider (#741)", () => {
  it("keeps the real provider's identity for tools that only read it", () => {
    const guarded = delegatedProvider(spyProvider());
    expect(guarded.name).toBe("anthropic");
    expect(guarded.model).toBe("spy-model");
  });

  it("refuses structured generation without reaching the real provider", async () => {
    const real = spyProvider();
    const guarded = delegatedProvider(real);
    await expect(
      guarded.generateObject({ systemPrompt: "s", messages: [], jsonSchema: {} } as never),
    ).rejects.toThrow(AI_DELEGATED_PREFIX);
    expect(real.calls).toBe(0);
  });

  it("refuses streamed generation on the first pull", async () => {
    const real = spyProvider();
    const guarded = delegatedProvider(real);
    const pull = async () => {
      for await (const _ of guarded.generate({} as never)) {
        // never reached
      }
    };
    await expect(pull()).rejects.toThrow(AI_DELEGATED_PREFIX);
    expect(real.calls).toBe(0);
  });
});
