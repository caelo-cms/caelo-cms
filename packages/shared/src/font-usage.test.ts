// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { scanSiteFontUsage } from "./font-usage.js";
import type { ThemeDocument } from "./themes.js";

const THEME = {
  typography: {
    body: { $type: "typography", $value: { fontFamily: "Inter", fontWeight: 400 } },
    heading: { $type: "typography", $value: { fontFamily: "Inter", fontWeight: 600 } },
  },
} as unknown as ThemeDocument;

function scan(...texts: string[]) {
  return scanSiteFontUsage({
    tokens: THEME,
    sources: texts.map((text, i) => ({ label: `module:m${i}`, text })),
  });
}

describe("scanSiteFontUsage", () => {
  it("always includes the initial 400, UA bold 700 and the bolder closure", () => {
    // Theme 600 → bolder 900; UA 700 → 900.
    expect(scan().weights).toEqual([400, 600, 700, 900]);
  });

  it("collects weights from CSS, inline styles, JSON-escaped content and the font shorthand", () => {
    const usage = scan(
      ".a{font-weight:300}.b{font-weight: bold !important}",
      '<p style="font-weight:500">x</p>',
      '{"body":"<span style=\\"font-weight:800\\">x</span>"}',
      ".c{font:italic 200 1rem/1.4 var(--font-body)}",
    );
    expect(usage.uncertain).toEqual([]);
    expect(usage.weights).toEqual([200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it("resolves var() against every declaration of the property, including theme vars", () => {
    const usage = scan(
      ".h{font-weight:var(--font-weight-heading)}",
      ".x{--w:350}.y{font-weight:var(--w, 450)}",
    );
    expect(usage.uncertain).toEqual([]);
    expect(usage.weights).toEqual([350, 400, 450, 600, 700, 900]);
  });

  it("applies the lighter closure only when lighter is used", () => {
    expect(scan(".a{font-weight:lighter}").weights).toEqual([100, 400, 600, 700, 900]);
  });

  it("reports uncertainty instead of guessing", () => {
    const cases = [
      ".a{font-weight:calc(400 + 100)}",
      ".a{font-weight:{{weight}}}",
      ".a{font-weight:var(--w)} el.style.setProperty('--w', 800)",
      "el.style.fontWeight = w;",
      ".a{font:menu}",
      ".a{transition:font-weight .2s}",
      "ctx.font = size + 'px Inter';",
    ];
    for (const text of cases) {
      const usage = scan(text);
      expect({ text, weights: usage.weights }).toEqual({ text, weights: null });
      expect(usage.uncertain[0]).toStartWith("module:m0: ");
    }
  });

  it("accepts literal camelCase weights in script", () => {
    expect(scan("const s = { fontWeight: 650 };").weights).toEqual([400, 600, 650, 700, 900]);
  });

  it("reports axes named by font-variation-settings, all of them when unparsable", () => {
    expect(scan(`.a{font-variation-settings:"opsz" 32, 'GRAD' -50}`).variationSettingsAxes).toEqual(
      ["GRAD", "opsz"],
    );
    expect(scan(".a{font-variation-settings:normal}").variationSettingsAxes).toEqual([]);
    expect(scan(".a{font-variation-settings:var(--v)}").variationSettingsAxes).toBe("all");
    expect(scan("el.style.fontVariationSettings = v").variationSettingsAxes).toBe("all");
    expect(scan().variationSettingsAxes).toEqual([]);
  });

  it("does not mistake custom property names for font-weight declarations", () => {
    expect(scan(".a{--font-weight-x:500}").weights).toEqual([400, 600, 700, 900]);
  });
});
