// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (2026-07-12): the crawler's aggregated CSS vars fed
 * `prepareLegacyAggregatedToken`, whose tail defaulted every
 * unclassifiable name to `spacing`. WordPress's
 * `--wp--preset--shadow--natural` (a CSS shadow string) landed in
 * `spacing.*` and the resulting TokenCategoryMismatch aborted the
 * ENTIRE imports.compose_from_run. Junk vars must be dropped, never
 * mis-binned. Pure-function test — no DB.
 */

import { describe, expect, it } from "bun:test";
import { isPlausibleFontFamilyValue, prepareLegacyAggregatedToken } from "../ops/imports.js";

describe("prepareLegacyAggregatedToken", () => {
  it("drops WP preset shadow vars instead of binning them as spacing", () => {
    expect(
      prepareLegacyAggregatedToken({
        token: "--wp--preset--shadow--natural",
        value: "6px 6px 9px rgba(0, 0, 0, 0.2)",
      }),
    ).toBeNull();
  });

  it("drops non-dimension junk that would land in spacing", () => {
    expect(
      prepareLegacyAggregatedToken({
        token: "--some-elementor-gradient",
        value: "linear-gradient(135deg, #0b3a5b, #06b6d4)",
      }),
    ).toBeNull();
  });

  it("keeps bare zero — explicitly valid per the shared dimension schema", () => {
    expect(
      prepareLegacyAggregatedToken({ token: "space-none", value: "0", scope: "space" }),
    ).toEqual({
      canonicalPath: "spacing.none",
      value: "0",
    });
  });

  it("keeps a real spacing dimension", () => {
    expect(
      prepareLegacyAggregatedToken({ token: "space-md", value: "1.5rem", scope: "space" }),
    ).toEqual({
      canonicalPath: "spacing.md",
      value: "1.5rem",
    });
  });

  // issue #32 — sampled type-scale composites land at the DTCG
  // typography root with the sub-field object intact (family + size +
  // weight + line-height), so the renderer emits the full scale.
  it("lands a sampled typography composite at the DTCG root", () => {
    expect(
      prepareLegacyAggregatedToken({
        token: "typography-heading",
        value: JSON.stringify({
          fontFamily: "Sora, sans-serif",
          fontSize: "40px",
          fontWeight: 700,
          lineHeight: "1.1",
        }),
        scope: "typography",
      }),
    ).toEqual({
      canonicalPath: "typography.heading",
      value: {
        fontFamily: "Sora, sans-serif",
        fontSize: "40px",
        fontWeight: 700,
        lineHeight: "1.1",
      },
    });
  });

  it("drops a typography composite whose payload is not a JSON object", () => {
    expect(
      prepareLegacyAggregatedToken({
        token: "typography-body",
        value: "not json",
        scope: "typography",
      }),
    ).toBeNull();
    expect(
      prepareLegacyAggregatedToken({
        token: "typography-body",
        value: "[1,2]",
        scope: "typography",
      }),
    ).toBeNull();
  });

  it("classifies radius by name keyword and validates the value", () => {
    expect(prepareLegacyAggregatedToken({ token: "--card-radius", value: "8px" })).toEqual({
      canonicalPath: "radius.--card-radius",
      value: "8px",
    });
    expect(
      prepareLegacyAggregatedToken({ token: "--card-radius", value: "8px 8px 0 0" }),
    ).toBeNull();
  });

  // Regression (run #8, 2026-07-13): WordPress `--wp--preset--font-size--*`
  // vars carry "font" in the NAME but a bare dimension VALUE. Pre-fix they
  // were wrapped as `{fontFamily: "13px"}` typography tokens; the deploy
  // then failed hard with `theme-font-unresolvable:36px, 13px, 20px, 42px`.
  // Numeric-only values must never register as font families — loud skip.
  it("skips WP preset font sizes with a loud note — the exact run #8 values", () => {
    const cases: Array<[string, string]> = [
      ["--wp--preset--font-size--x-large", "36px"],
      ["--wp--preset--font-size--small", "13px"],
      ["--wp--preset--font-size--medium", "20px"],
      ["--wp--preset--font-size--xx-large", "42px"],
    ];
    for (const [token, value] of cases) {
      expect(prepareLegacyAggregatedToken({ token, value })).toEqual({
        skipNote: `theme-token-skipped-nonfont-typography:${token}=${value}`,
      });
    }
  });

  it("skips numeric font weights and unitless line-heights routed via scope 'font'", () => {
    expect(
      prepareLegacyAggregatedToken({ token: "font-weight-bold", value: "700", scope: "font" }),
    ).toEqual({
      skipNote: "theme-token-skipped-nonfont-typography:font-weight-bold=700",
    });
    expect(
      prepareLegacyAggregatedToken({ token: "--body-font-line-height", value: "1.5" }),
    ).toEqual({
      skipNote: "theme-token-skipped-nonfont-typography:--body-font-line-height=1.5",
    });
  });

  it("isPlausibleFontFamilyValue accepts real stacks, rejects dimension lists", () => {
    expect(isPlausibleFontFamilyValue("Inter, sans-serif")).toBe(true);
    expect(isPlausibleFontFamilyValue('"Helvetica Neue", Arial')).toBe(true);
    expect(isPlausibleFontFamilyValue("36px, 13px, 20px, 42px")).toBe(false);
    expect(isPlausibleFontFamilyValue("1.5rem")).toBe(false);
    expect(isPlausibleFontFamilyValue("")).toBe(false);
  });

  it("keeps hex colors and font families", () => {
    expect(
      prepareLegacyAggregatedToken({ token: "color-primary", value: "#135e96", scope: "color" }),
    ).toEqual({
      canonicalPath: "color.primary",
      value: "#135e96",
    });
    expect(
      prepareLegacyAggregatedToken({ token: "--body-font-family", value: "Inter, sans-serif" }),
    ).toEqual({
      canonicalPath: "typography.--body-font-family",
      value: { fontFamily: "Inter, sans-serif" },
    });
  });
});
