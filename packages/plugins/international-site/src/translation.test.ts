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
    expect(system).toContain("Return ONE entry per source module");
    expect(system).toContain("## Glossary (use these exact translations)");
    expect(system).toContain('"checkout" → "Kasse" (e-commerce)');
    expect(system).toContain("## Style guide");
    expect(system).toContain("Use informal du.");
    expect(user).toContain("Title: Pricing");
    expect(user).toContain("### Module m-main (block=main, position=0)");
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

  it("full mode demands exactly the source slots", () => {
    validateStructuralLock(
      {
        slots: [
          { blockName: "main", position: 0, values: { h: "x" } },
          { blockName: "main", position: 1, values: { h: "y" } },
        ],
      },
      alignment,
      "full",
    );
    expect(() =>
      validateStructuralLock(
        { slots: [{ blockName: "main", position: 0, values: { h: "x" } }] },
        alignment,
        "full",
      ),
    ).toThrow(/missing slot main\|1/);
    expect(() =>
      validateStructuralLock(
        {
          slots: [
            { blockName: "main", position: 0, values: { h: "x" } },
            { blockName: "main", position: 1, values: { h: "y" } },
            { blockName: "ghost", position: 9, values: { h: "z" } },
          ],
        },
        alignment,
        "full",
      ),
    ).toThrow(/does not exist on the source page/);
  });

  it("update mode allows a subset but never unaligned slots or duplicates", () => {
    validateStructuralLock(
      { slots: [{ blockName: "main", position: 1, values: { h: "y" } }] },
      alignment,
      "update",
    );
    validateStructuralLock({ slots: [] }, alignment, "update");
    expect(() =>
      validateStructuralLock(
        { slots: [{ blockName: "ghost", position: 0, values: { h: "z" } }] },
        alignment,
        "update",
      ),
    ).toThrow(/not aligned/);
    expect(() =>
      validateStructuralLock(
        {
          slots: [
            { blockName: "main", position: 0, values: { h: "x" } },
            { blockName: "main", position: 0, values: { h: "x2" } },
          ],
        },
        alignment,
        "update",
      ),
    ).toThrow(/duplicate slot/);
  });
});
