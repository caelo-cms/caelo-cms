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
import { prepareLegacyAggregatedToken } from "../ops/imports.js";

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

  it("keeps a real spacing dimension", () => {
    expect(
      prepareLegacyAggregatedToken({ token: "space-md", value: "1.5rem", scope: "space" }),
    ).toEqual({
      canonicalPath: "spacing.md",
      value: "1.5rem",
    });
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
