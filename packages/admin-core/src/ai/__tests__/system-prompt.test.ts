// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPrompt } from "../system-prompt.js";

describe("composeSystemPrompt", () => {
  it("orders slots deterministically regardless of input order", () => {
    const a = composeSystemPrompt([
      { slot: "tone", body: "warm" },
      { slot: "brand-voice", body: "terse" },
    ]);
    const b = composeSystemPrompt([
      { slot: "brand-voice", body: "terse" },
      { slot: "tone", body: "warm" },
    ]);
    expect(a).toBe(b);
    // Brand voice section must precede tone in the output.
    expect(a.indexOf("Brand voice")).toBeLessThan(a.indexOf("Tone"));
  });

  it("skips empty slots", () => {
    const out = composeSystemPrompt([{ slot: "tone", body: "   " }]);
    expect(out).not.toContain("Tone");
  });

  it("never emits a prose tool catalogue (descriptions live only in tools[])", () => {
    const out = composeSystemPrompt([]);
    // Token efficiency: the system prompt must not duplicate tool names +
    // descriptions — those ship only in the provider `tools[]` array.
    expect(out).not.toContain("Available tools");
  });

  it("never includes provider brand strings", () => {
    const out = composeSystemPrompt([{ slot: "brand-voice", body: "use Claude or Anthropic terms" }]);
    // The user's own memory body can mention anything, but the sections we
    // author must not name the provider.
    const ourSections = out.split("# Site memory")[0] ?? "";
    expect(ourSections.toLowerCase()).not.toContain("claude");
    expect(ourSections.toLowerCase()).not.toContain("anthropic");
  });

  it("starts with the base 'You are Caelo' instruction", () => {
    const out = composeSystemPrompt([]);
    expect(out.startsWith("You are Caelo")).toBe(true);
  });
});
