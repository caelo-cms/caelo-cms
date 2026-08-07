// SPDX-License-Identifier: MPL-2.0

/**
 * #397 — pure-logic tests for the translation core: slot alignment,
 * prompt construction (the STRUCTURAL LOCK + glossary + style-guide
 * blocks the deleted P10 design mandated), the strict result contract,
 * and structural-lock validation.
 */

import { describe, expect, it } from "bun:test";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildSlotIndex,
  buildUpdateTranslationPrompt,
  type ContentSlot,
  stripJsonFence,
  translationResultPayload,
  validateStructuralLock,
} from "./translation.js";

const slot = (
  blockName: string,
  position: number,
  values: Record<string, unknown>,
): ContentSlot => ({ blockName, position, moduleSlug: `m-${blockName}`, values });

describe("alignSlots", () => {
  it("pairs by (blockName, position) and flags structural drift", () => {
    const source = [slot("main", 0, { h: "Hi" }), slot("main", 1, { p: "New" })];
    const variant = [slot("main", 0, { h: "Hallo" }), slot("footer", 0, { c: "Alt" })];
    const alignment = alignSlots(source, variant);
    expect(alignment.filter((a) => a.kind === "aligned")).toHaveLength(1);
    expect(alignment.find((a) => a.kind === "added")?.position).toBe(1);
    expect(alignment.find((a) => a.kind === "removed")?.blockName).toBe("footer");
  });
});

describe("prompt construction", () => {
  const base = {
    sourceLocale: "en",
    targetLocale: "de",
    targetLocaleDisplayName: "Deutsch",
    sourceTitle: "Pricing",
    sourceSlots: [slot("main", 0, { headline: "Welcome", count: 3 })],
    glossary: [{ term: "checkout", translation: "Kasse", context: "e-commerce" }],
    styleGuide: "Use informal du.",
  };

  it("full mode carries the structural lock, glossary, style guide, and only string fields", () => {
    const { system, user } = buildFullTranslationPrompt(base);
    expect(system).toContain("STRUCTURAL LOCK");
    expect(system).toContain("You may NOT add, remove, or reorder modules");
    expect(system).toContain("Return ONE entry per slot listed below");
    // The identifier contract is the load-bearing part: a live run had
    // the model answer with the MODULE SLUG as the block name, the
    // structural lock refused the whole translation, and the AI fell
    // back to translating by hand. One opaque token, copied verbatim.
    expect(system).toContain('"slot": "<the slot id from the heading, copied EXACTLY');
    expect(system).toContain("never substitute the module slug or block name for it");
    expect(system).toContain("## Glossary (use these exact translations)");
    expect(system).toContain('"checkout" → "Kasse" (e-commerce)');
    expect(system).toContain("## Style guide");
    expect(system).toContain("Use informal du.");
    expect(user).toContain("Title: Pricing");
    // The id leads the heading; the module slug trails it as context.
    expect(user).toContain("### Slot s0 (module m-main, block main)");
    expect(user).toContain("Welcome");
    // Non-string values never reach the model — they are not translatable.
    expect(user).not.toContain("count");
  });

  it("update mode ships source + existing translation + the alignment section", () => {
    const variantSlots = [slot("main", 0, { headline: "Willkommen" })];
    const { system, user } = buildUpdateTranslationPrompt({
      ...base,
      variantTitle: "Preise",
      variantSlots,
      alignment: alignSlots(base.sourceSlots, variantSlots),
    });
    expect(system).toContain("OMITTING those slots");
    expect(system).toContain("do NOT include unchanged slots");
    expect(user).toContain("## Current source (full, for context)");
    expect(user).toContain("## Existing translation (preserve unchanged slots verbatim)");
    expect(user).toContain("Title: Preise");
    expect(user).toContain("(structures are aligned — every slot exists in both languages)");
  });

  it("update mode names ADDED/REMOVED drift explicitly", () => {
    const sourceSlots = [slot("main", 0, { h: "A" }), slot("main", 1, { h: "B" })];
    const variantSlots = [slot("main", 0, { h: "A2" }), slot("aside", 0, { h: "C" })];
    const { user } = buildUpdateTranslationPrompt({
      ...base,
      sourceSlots,
      variantTitle: "T",
      variantSlots,
      alignment: alignSlots(sourceSlots, variantSlots),
    });
    expect(user).toContain("### ADDED in source — block=main position=1");
    expect(user).toContain("### REMOVED from source — block=aside position=0");
  });
});

describe("result contract", () => {
  it("rejects extra keys and non-string values", () => {
    expect(() => translationResultPayload.parse({ slots: [], extra: true })).toThrow();
    expect(() =>
      translationResultPayload.parse({
        slots: [{ blockName: "main", position: 0, values: { h: 1 } }],
      }),
    ).toThrow();
  });

  it("stripJsonFence tolerates a fenced payload", () => {
    const fenced = '```json\n{"slots": []}\n```';
    expect(JSON.parse(stripJsonFence(fenced))).toEqual({ slots: [] });
    expect(stripJsonFence('{"slots": []}')).toBe('{"slots": []}');
  });
});

describe("validateStructuralLock", () => {
  const alignment = alignSlots(
    [slot("main", 0, { h: "A" }), slot("main", 1, { h: "B" })],
    [slot("main", 0, { h: "A2" }), slot("main", 1, { h: "B2" })],
  );

  const index = buildSlotIndex([slot("main", 0, { h: "A" }), slot("main", 1, { h: "B" })]);

  it("full mode demands exactly the source slots", () => {
    validateStructuralLock(
      {
        slots: [
          { slot: "s0", values: { h: "x" } },
          { slot: "s1", values: { h: "y" } },
        ],
      },
      alignment,
      "full",
      index,
    );
    expect(() =>
      validateStructuralLock(
        { slots: [{ slot: "s0", values: { h: "x" } }] },
        alignment,
        "full",
        index,
      ),
    ).toThrow(/missing slot main\|1/);
  });

  it("refuses a slot id that was never offered, naming the valid ones", () => {
    // The exact live failure: the model answered with the module slug
    // instead of the id it was handed.
    expect(() =>
      validateStructuralLock(
        { slots: [{ slot: "livedit-intl-hero", values: { h: "x" } }] },
        alignment,
        "full",
        index,
      ),
    ).toThrow(/was not offered in the prompt \(valid ids: s0, s1\)/);
  });

  it("update mode allows a subset but never unaligned slots or duplicates", () => {
    validateStructuralLock(
      { slots: [{ slot: "s1", values: { h: "y" } }] },
      alignment,
      "update",
      index,
    );
    validateStructuralLock({ slots: [] }, alignment, "update", index);
    const ghostIndex = buildSlotIndex([slot("ghost", 0, { h: "z" })]);
    expect(() =>
      validateStructuralLock(
        { slots: [{ slot: "s0", values: { h: "z" } }] },
        alignment,
        "update",
        ghostIndex,
      ),
    ).toThrow(/not aligned/);
    expect(() =>
      validateStructuralLock(
        {
          slots: [
            { slot: "s0", values: { h: "x" } },
            { slot: "s0", values: { h: "x2" } },
          ],
        },
        alignment,
        "update",
        index,
      ),
    ).toThrow(/duplicate slot/);
  });
});
