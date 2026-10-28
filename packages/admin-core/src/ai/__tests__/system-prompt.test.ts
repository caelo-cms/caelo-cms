// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPrompt, formatThemeBlock } from "../system-prompt.js";
import { TYPOGRAPHY_COMPOSITION_HINTS } from "../theme-guidance.js";

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

  // NOTE: there is no "includes tool catalogue" test any more. The catalogue is
  // no longer rendered into the system prompt — tools reach the model through
  // the provider's `tools` payload (which is what per-turn describeSchema and
  // prompt caching require), and `composeSystemPrompt` now takes memory only.
  // That path is covered by tool-search.test.ts and, end-to-end into the real
  // provider payload, by block-name-enum-threading.integration.test.ts.

  it("never includes provider brand strings", () => {
    const out = composeSystemPrompt([
      { slot: "brand-voice", body: "use Claude or Anthropic terms" },
    ]);
    // The user's own memory body can mention anything, but the BASE_SYSTEM
    // and the blocks we author must not name the provider.
    const ourSections = out.split("# Site memory")[0] ?? "";
    expect(ourSections.toLowerCase()).not.toContain("claude");
    expect(ourSections.toLowerCase()).not.toContain("anthropic");
  });

  it("starts with the base 'You are Caelo' instruction", () => {
    const out = composeSystemPrompt([]);
    expect(out.startsWith("You are Caelo")).toBe(true);
  });

  // An operator asking for one wording change got a full Stage (merge,
  // staging build, quality check) every time: the AI stages when the user
  // asks or to re-check its own quality fixes, and otherwise ends a change
  // turn by offering the Stage.
  it("stages on request only and ends a change turn with the offer", () => {
    const out = composeSystemPrompt([]);
    expect(out).toContain("Do not stage on your own.");
    expect(out).toContain("only when the user asks for it");
    expect(out).toContain("re-check your own fixes in a quality fix round");
    expect(out).not.toContain("Never leave the Stage to the user");
  });

  // Issue #667 / #727 — the quality target (100 / zero findings, the
  // truly unfixable to the user as a bulk decision, never recommended) is
  // carried by every fix request and the quality tools, which the AI reads
  // exactly when findings exist; the always-cached prompt only has to make
  // sure a Stage happens and Publish live stays the user's.
  it("leaves the quality target to the fix request and keeps Publish live the user's", () => {
    const out = composeSystemPrompt([]);
    expect(out).toContain("Publish live is always the user's click");
    expect(out).toContain("never claim a change is live");
    expect(out).not.toContain("accept_quality_findings");
  });
});

it("keeps typographic intent in the active theme context", () => {
  expect(
    formatThemeBlock({
      displayName: "Brand",
      slug: "brand",
      tokensSummary: "Warm editorial",
      origin: "operator",
    }),
  ).toContain(TYPOGRAPHY_COMPOSITION_HINTS);
});
