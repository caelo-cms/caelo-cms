// SPDX-License-Identifier: MPL-2.0

/**
 * Dimension values accept CSS math functions (e2e-livedit run 40018361466:
 * set_theme_tokens refused `typography.display` with a fluid
 * `clamp(2.5rem, 2rem + 2.5vw, 4rem)` font size, and the error printed the
 * truncated composite value, which hid the field it was about).
 */

import { describe, expect, it } from "bun:test";
import { themeDocument } from "./themes.js";

const display = (fontSize: string) => ({
  typography: {
    display: {
      $type: "typography",
      $value: {
        fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize,
        fontWeight: 800,
        lineHeight: 1.05,
      },
    },
  },
});

describe("theme dimension values", () => {
  it("accept clamp() / calc() / min() / max() font sizes and spacing", () => {
    for (const v of [
      "clamp(2.5rem, 2rem + 2.5vw, 4rem)",
      "calc(1rem + 0.5vw)",
      "min(4rem, 10vw)",
      "max(1rem, calc(0.75rem + 1vw))",
    ]) {
      expect(themeDocument.safeParse(display(v)).success).toBe(true);
    }
    const spacing = {
      spacing: { section: { $type: "dimension", $value: "clamp(2rem, 5vw, 5rem)" } },
    };
    expect(themeDocument.safeParse(spacing).success).toBe(true);
  });

  it("still refuse values that are not a length, and math functions that could close the declaration", () => {
    for (const v of [
      "large",
      "clamp(1rem; } body { display:none }",
      "calc(1rem)</style>",
      "url(x)",
    ]) {
      expect(themeDocument.safeParse(display(v)).success).toBe(false);
    }
  });

  it("name the offending field's value, not the truncated composite", () => {
    const r = themeDocument.safeParse(display("large"));
    expect(r.success).toBe(false);
    if (r.success) return;
    const message = r.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain('(got "large")');
  });
});
