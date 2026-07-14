// SPDX-License-Identifier: MPL-2.0

/**
 * Token efficiency (run-logs/token-efficiency-analysis.md): a live build
 * turn failed on `set_theme_tokens` because the shadow token `$value`
 * accepted only the DTCG object form, an array, or an alias — NOT the
 * literal CSS `box-shadow` string a model naturally emits. That forced an
 * error + retry. This pins the tolerant string form: it validates AND
 * renders verbatim, while the object form still expands.
 */

import { describe, expect, it } from "bun:test";
import { renderThemeCss } from "./theme-render.js";
import { type ThemeDocument, themeDocument } from "./themes.js";

function docWithShadow(value: unknown): unknown {
  return {
    color: { primary: { $type: "color", $value: "#4f46e5" } },
    shadow: { lg: { $type: "shadow", $value: value } },
  };
}

describe("shadow token accepts literal CSS strings (token-efficiency fix)", () => {
  it("accepts a literal CSS box-shadow string", () => {
    for (const v of [
      "0 4px 6px -1px rgba(0,0,0,0.1)",
      "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
      "0 10px 15px -3px #00000022, 0 4px 6px -4px #00000022",
      "none",
      "inset 0 2px 4px rgba(0,0,0,0.06)",
    ]) {
      const r = themeDocument.safeParse(docWithShadow(v));
      expect(r.success).toBe(true);
    }
  });

  it("still accepts the DTCG object form and aliases", () => {
    expect(
      themeDocument.safeParse(
        docWithShadow({ color: "#00000022", offsetX: "0", offsetY: "4px", blur: "6px" }),
      ).success,
    ).toBe(true);
    expect(themeDocument.safeParse(docWithShadow("{shadow.base}")).success).toBe(true);
  });

  it("rejects a declaration-breakout attempt", () => {
    // `;` and `{` are outside the shadow char-class → not a valid literal.
    expect(themeDocument.safeParse(docWithShadow("0 0 0 red; color: red")).success).toBe(false);
  });

  it("renders a literal string shadow verbatim to CSS", () => {
    const doc = docWithShadow("0 4px 6px -1px rgba(0,0,0,0.1)") as ThemeDocument;
    const css = renderThemeCss(doc);
    expect(css).toContain("--shadow-lg:0 4px 6px -1px rgba(0,0,0,0.1);");
  });
});
