// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 2 — mechanical token binding: value-map parsing from
 * renderer output (aliases + ramps included by construction), color +
 * whole-gradient rewrites, stop-color protection inside unmatched
 * gradients, dimension suggestions (never auto-rewritten), reporting.
 */

import { describe, expect, it } from "bun:test";
import {
  applyThemeLiteralBinding,
  buildThemeValueMap,
  formatBindingReport,
} from "./theme-literal-binding.js";
import type { ThemeDocument } from "./themes.js";

const TOKENS = {
  color: {
    primary: { $type: "color", $value: "#4F46E5" },
    foreground: { $type: "color", $value: "#0f172a" },
    accent: { $type: "color", $value: "{color.primary}" },
  },
  gradient: {
    hero: { $type: "gradient", $value: "linear-gradient(135deg, #4f46e5, #7c3aed)" },
  },
  spacing: { xl: { $type: "dimension", $value: "6rem" } },
} as unknown as ThemeDocument;

describe("buildThemeValueMap", () => {
  it("maps normalized renderer-emitted values to var names (aliases resolved)", () => {
    const map = buildThemeValueMap(TOKENS);
    expect(map.colors.get("#4f46e5")).toBe("--color-primary"); // first-declared wins over alias
    expect(map.colors.get("#0f172a")).toBe("--color-foreground");
    expect(map.gradients.get("linear-gradient(135deg, #4f46e5, #7c3aed)")).toBe("--gradient-hero");
    expect(map.dimensions.get("6rem")).toBe("--spacing-xl");
  });
});

describe("applyThemeLiteralBinding", () => {
  it("binds whole gradients before stop colors, and matching colors elsewhere", () => {
    const css =
      ".hero{background:linear-gradient(135deg, #4F46E5, #7c3aed)}.cta{background:#4f46e5;color:#fff}";
    const r = applyThemeLiteralBinding(css, TOKENS);
    expect(r.css).toContain("background:var(--gradient-hero)");
    expect(r.css).toContain("background:var(--color-primary)");
    expect(r.css).toContain("color:#fff"); // unknown literal stays
    expect(r.rewrites.map((x) => x.to).sort()).toEqual(["--color-primary", "--gradient-hero"]);
  });

  it("leaves stop colors inside UNMATCHED gradients literal (no half-tokenising)", () => {
    const css = ".x{background:linear-gradient(90deg, #4f46e5, #000000)}";
    const r = applyThemeLiteralBinding(css, TOKENS);
    expect(r.css).toBe(css);
    expect(r.rewrites).toEqual([]);
  });

  it("suggests dimension tokens without rewriting", () => {
    const css = ".s{padding:6rem 2rem}";
    const r = applyThemeLiteralBinding(css, TOKENS);
    expect(r.css).toBe(css);
    expect(r.suggestions).toEqual([{ literal: "6rem", varName: "--spacing-xl" }]);
  });

  it("formats a report and stays silent on no-ops", () => {
    const bound = applyThemeLiteralBinding(".a{color:#0F172A}", TOKENS);
    expect(formatBindingReport(bound)).toContain("#0F172A→var(--color-foreground)");
    const noop = applyThemeLiteralBinding(".a{color:#123456}", TOKENS);
    expect(formatBindingReport(noop)).toBeNull();
  });
});
