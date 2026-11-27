// SPDX-License-Identifier: MPL-2.0

/** #1757 — alt text style hints: after the AI writes, never as findings. */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { ALT_TEXT_HINT_RULE, altTextHints } from "./alt-text.js";
import { seoWriteHints } from "./index.js";

const ctx = {} as PluginContextTier1;

describe("altTextHints", () => {
  it("says nothing about a good alt or a decorative one", () => {
    expect(altTextHints("The team at the summer offsite in Berlin")).toEqual([]);
    expect(altTextHints("")).toEqual([]);
  });

  it("flags an alt that calls itself an image", () => {
    expect(altTextHints("Image of a red bicycle")[0]).toContain("screen readers already say so");
    expect(altTextHints("Bild von einem Fahrrad")[0]).toContain("screen readers already say so");
    expect(altTextHints("Imagery of the coast")).toEqual([]);
  });

  it("flags an alt too long or too short, and a file name", () => {
    expect(altTextHints("x".repeat(130))[0]).toContain("130 characters");
    expect(altTextHints("Cat")[0]).toContain("very short");
    expect(altTextHints("IMG_0042.jpg")[0]).toContain("file name");
  });
});

describe("the alt text hint rule", () => {
  it("reads library alts, module markup and alt fields", async () => {
    const hints = await ALT_TEXT_HINT_RULE.hints(ctx, [
      { kind: "media_alt", assetId: "a", alt: "Photo of the office" },
      {
        kind: "module",
        moduleId: null,
        html: '<img src="a" alt="Our team"><img src="b" alt="Our team"><img src="{{img}}" alt="{{img_alt}}">',
        fields: [],
      },
      { kind: "values", moduleId: null, values: { hero_alt: "Pic", hero_title: "Pic" } },
    ]);
    expect(hints.some((h) => h.includes("Photo of the office"))).toBe(true);
    expect(hints.some((h) => h.includes('share the alt text "Our team"'))).toBe(true);
    expect(hints.some((h) => h.includes('"Pic" is very short'))).toBe(true);
    // A title field is no alt; a placeholder is checked where it is filled.
    expect(hints.filter((h) => h.includes('"Pic"'))).toHaveLength(1);
    expect(hints.some((h) => h.includes("{{"))).toBe(false);
  });

  it("goes through the write hints operation within the SDK's limits", async () => {
    const { hints } = await seoWriteHints(ctx, {
      writes: Array.from({ length: 8 }, (_, i) => ({
        kind: "media_alt",
        assetId: `a${i}`,
        alt: `Image of thing ${i}`,
      })),
    });
    expect(hints.length).toBeLessThanOrEqual(5);
    for (const h of hints) expect(h.length).toBeLessThanOrEqual(600);
  });
});
