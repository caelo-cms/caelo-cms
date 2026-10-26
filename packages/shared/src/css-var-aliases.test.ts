// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  formatCssVarRenameReport,
  renameCssVarAliases,
  themeVarForAlias,
} from "./css-var-aliases.js";
import { scanCssVars } from "./css-var-scan.js";

const THEME = [
  "--color-background",
  "--color-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-border",
  "--color-accent",
];

describe("renameCssVarAliases", () => {
  // The header CSS of e2e-livedit run 40351690739.
  const css =
    ".site-header{border-bottom:1px solid var(--color-border, #e5e5e5);background:var(--color-surface, #fff);}\n" +
    ".site-header__brand{color:var(--color-text, #111);}\n" +
    ".site-header__panel{background:var(--color-surface, #fff);}\n" +
    ".site-header__col h3{color:var(--color-text-muted,#888);}";

  it("renames common role names to the theme's names, every occurrence", () => {
    const r = renameCssVarAliases(css, THEME, new Set());
    expect(r.css).not.toContain("--color-surface");
    expect(r.css).not.toContain("var(--color-text,");
    expect(r.css).toContain("background:var(--color-background, #fff)");
    expect(r.css).toContain("color:var(--color-foreground, #111)");
    expect(r.css).toContain("color:var(--color-muted-foreground,#888)");
    expect(r.renames).toEqual([
      { from: "--color-surface", to: "--color-background", count: 2 },
      { from: "--color-text", to: "--color-foreground", count: 1 },
      { from: "--color-text-muted", to: "--color-muted-foreground", count: 1 },
    ]);
    expect(formatCssVarRenameReport(r.renames)).toContain("--color-surface→--color-background×2");
  });

  it("leaves known names, the author's own properties and unmapped names alone", () => {
    const own = ":root{--surface:#fafafa}.a{background:var(--surface);color:var(--brand-ink)}";
    const r = renameCssVarAliases(own, THEME, new Set(["--surface"]));
    expect(r.css).toBe(own);
    expect(r.renames).toEqual([]);
  });

  it("renames only when the theme emits the target", () => {
    expect(themeVarForAlias("--color-surface-raised", new Set(THEME))).toBeNull();
    expect(themeVarForAlias("--text", new Set(THEME))).toBe("--color-foreground");
  });
});

describe("scanCssVars suggestions", () => {
  it("suggests the theme's role name, not the nearest spelling", () => {
    const [u] = scanCssVars({ css: ".a{color:var(--color-text, #111)}", knownVars: THEME });
    expect(u?.suggestion).toBe("--color-foreground");
  });
});
