// SPDX-License-Identifier: MPL-2.0
/**
 * Regression: saving the Typography tab posts every sub-field of a named
 * style as its own `typography.<style>.<sub>` key, with lineHeight /
 * fontWeight coerced to numbers. Numbers used to skip the composite wrap
 * (so `$value` became a bare `1.6`) and sibling sub-fields overwrote each
 * other on the shared composite path.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTokens } from "./theme-normalize.js";
import { applyDtcgWrites, themeDocument } from "./themes.js";

describe("normalizeTokens typography sub-fields", () => {
  it("wraps numeric sub-field values into the composite", () => {
    const r = normalizeTokens({ "typography.body.lineHeight": 1.6 });
    expect(r.set["typography.body"]).toEqual({ lineHeight: 1.6 });
  });

  it("merges several sub-fields of one style into one composite", () => {
    const r = normalizeTokens({
      fontHeading: "Inter, sans-serif",
      "typography.heading.fontSize": "3rem",
      "typography.heading.fontWeight": 650,
      "typography.heading.lineHeight": 1.08,
    });
    expect(r.set["typography.heading"]).toEqual({
      fontFamily: "Inter, sans-serif",
      fontSize: "3rem",
      fontWeight: 650,
      lineHeight: 1.08,
    });
    expect(r.canonicalPaths).toEqual(["typography.heading"]);
  });

  it("produces a valid document when applied over an existing theme", () => {
    const current = {
      typography: {
        body: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "1rem" } },
      },
    };
    const r = normalizeTokens({
      "typography.body.fontWeight": 400,
      "typography.body.lineHeight": 1.6,
    });
    const next = applyDtcgWrites(current as never, r.set, r.types);
    expect(themeDocument.safeParse(next).success).toBe(true);
    expect((next.typography as Record<string, { $value: unknown }>).body?.$value).toEqual({
      fontFamily: "Inter",
      fontSize: "1rem",
      fontWeight: 400,
      lineHeight: 1.6,
    });
  });
});
