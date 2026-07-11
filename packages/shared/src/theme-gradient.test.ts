// SPDX-License-Identifier: MPL-2.0

/**
 * issue #153 — first-class `gradient` token category: boundary
 * validation (well-formed CSS gradient strings only; no url(), no
 * declaration breakout) and renderer emission as `--gradient-<name>`.
 */

import { describe, expect, it } from "bun:test";
import { listThemeCssVarNames, renderThemeCss } from "./theme-render.js";
import { type ThemeDocument, themeDocument, themeGradientToken } from "./themes.js";

function docWithGradient(value: string): unknown {
  return {
    color: { primary: { $type: "color", $value: "#4f46e5" } },
    gradient: { hero: { $type: "gradient", $value: value } },
  };
}

describe("themeGradientToken boundary (issue #153)", () => {
  it("accepts linear / radial / conic / repeating gradients and aliases", () => {
    for (const v of [
      "linear-gradient(135deg, #4f46e5, #7c3aed)",
      "radial-gradient(circle at 30% 20%, #06b6d4, transparent)",
      "conic-gradient(from 90deg, #f59e0b, #ef4444)",
      "repeating-linear-gradient(45deg, #0f172a 0 10px, #1e293b 10px 20px)",
    ]) {
      const r = themeDocument.safeParse(docWithGradient(v));
      expect(r.success).toBe(true);
    }
    expect(
      themeDocument.safeParse({
        gradient: {
          hero: { $value: "linear-gradient(135deg, #4f46e5, #7c3aed)" },
          subtle: { $type: "gradient", $value: "{gradient.hero}" },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects url()-carrying, declaration-breaking, and non-gradient values", () => {
    for (const v of [
      "linear-gradient(135deg, url(https://evil.example/x), #fff)",
      "linear-gradient(90deg, #fff, #000); background: red",
      "linear-gradient(90deg, #fff, #000)} body{display:none",
      "not-a-gradient(#fff, #000)",
    ]) {
      // Document-level: none of these match ANY token shape.
      expect(themeDocument.safeParse(docWithGradient(v)).success).toBe(false);
      // Token-level: the gradient schema itself names the reason.
      expect(themeGradientToken.safeParse({ $type: "gradient", $value: v }).success).toBe(false);
    }
    // Per-category leaf enforcement (#153): a plain color string under
    // gradient.* fails BOTH the token schema and the document boundary —
    // pre-#153 it silently validated as another category's token.
    expect(themeGradientToken.safeParse({ $type: "gradient", $value: "#4f46e5" }).success).toBe(
      false,
    );
    expect(themeDocument.safeParse(docWithGradient("#4f46e5")).success).toBe(false);
  });

  it("closes the pre-#153 hole: invalid leaves no longer pass as metadata groups", () => {
    // Before the per-category walker, {$value: <garbage>} fell back to
    // validating as a "group" of $-metadata and STILL got emitted into
    // CSS by the renderer — silent acceptance (CLAUDE.md §2).
    // ("notacolor" would pass — the color schema deliberately admits any
    // single word as a potential CSS named color; the breakout shape
    // below matches no color form at all.)
    expect(
      themeDocument.safeParse({
        color: { primary: { $type: "color", $value: "red; background:url(x)" } },
      }).success,
    ).toBe(false);
    expect(
      themeDocument.safeParse({ spacing: { md: { $value: "not-a-dimension" } } }).success,
    ).toBe(false);
    // Unknown categories keep the DTCG open-vocabulary tolerance.
    expect(
      themeDocument.safeParse({ effect: { blur: { $type: "blur", $value: "8px" } } }).success,
    ).toBe(true);
  });
});

describe("gradient rendering (issue #153)", () => {
  const doc = docWithGradient("linear-gradient(135deg, #4f46e5, #7c3aed)") as ThemeDocument;

  it("emits --gradient-<name> and lists it in the var inventory", () => {
    const css = renderThemeCss(doc);
    expect(css).toContain("--gradient-hero:linear-gradient(135deg, #4f46e5, #7c3aed);");
    expect(listThemeCssVarNames(doc)).toContain("--gradient-hero");
  });
});
