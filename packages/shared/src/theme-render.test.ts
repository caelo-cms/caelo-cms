// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — unit tests for `listThemeCssVarNames`.
 *
 * The function is the load-bearing fix for the CSS-var-invention bug:
 * without an authoritative list of the names the renderer emits, the
 * AI guesses names that don't exist (`--color-text`, `--color-surface`)
 * and its module CSS falls through to hardcoded fallbacks.
 */

import { describe, expect, it } from "bun:test";
import { listThemeCssVarNames, renderThemeCss } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

describe("listThemeCssVarNames (v0.11.4)", () => {
  it("returns empty array for an empty document", () => {
    expect(listThemeCssVarNames({} as ThemeDocument)).toEqual([]);
  });

  it("lists every var name the renderer would emit for shadcn-default colors", () => {
    const tokens: ThemeDocument = {
      color: {
        background: { $type: "color", $value: "#ffffff" },
        foreground: { $type: "color", $value: "#0a0a0a" },
        primary: { $type: "color", $value: "#171717" },
        "muted-foreground": { $type: "color", $value: "#737373" },
      },
    } as ThemeDocument;
    const names = listThemeCssVarNames(tokens);
    expect(names).toContain("--color-background");
    expect(names).toContain("--color-foreground");
    expect(names).toContain("--color-primary");
    expect(names).toContain("--color-muted-foreground");
    // The set is exactly the four we defined — no extras.
    expect(names.length).toBe(4);
  });

  it("emits typography sub-fields with the renderer's naming convention", () => {
    const tokens: ThemeDocument = {
      typography: {
        body: {
          $type: "typography",
          $value: {
            fontFamily: "system-ui",
            fontSize: "1rem",
            fontWeight: 400,
            lineHeight: 1.5,
          },
        },
      },
    } as ThemeDocument;
    const names = listThemeCssVarNames(tokens);
    // The renderer maps typography sub-fields to category-prefixed vars:
    //   fontFamily → --font-<name>
    //   fontSize   → --text-<name>
    //   fontWeight → --font-weight-<name>
    //   lineHeight → --leading-<name>
    expect(names).toContain("--font-body");
    expect(names).toContain("--text-body");
    expect(names).toContain("--font-weight-body");
    expect(names).toContain("--leading-body");
  });

  it("handles the DEFAULT-alias group-suffix shape (ramp leaves)", () => {
    const tokens: ThemeDocument = {
      color: {
        primary: {
          "50": { $type: "color", $value: "#eef2ff" },
          "500": { $type: "color", $value: "#6366f1" },
          DEFAULT: { $type: "color", $value: "#4f46e5" },
        },
      },
    } as ThemeDocument;
    const names = listThemeCssVarNames(tokens);
    // DEFAULT → bare `--color-primary` (NOT `--color-primary-DEFAULT`).
    expect(names).toContain("--color-primary");
    expect(names).toContain("--color-primary-50");
    expect(names).toContain("--color-primary-500");
    expect(names).not.toContain("--color-primary-DEFAULT");
  });

  it("the returned names match the names the actual renderer emits", () => {
    // Regression guard: the helper's output MUST stay in sync with
    // `renderThemeCss` — they share the same `emitTokenLines` path,
    // but a future change to one without the other would silently
    // mislead the AI.
    const tokens: ThemeDocument = {
      color: {
        primary: { $type: "color", $value: "#4f46e5" },
        accent: { $type: "color", $value: "#ec4899" },
      },
      spacing: {
        md: { $type: "dimension", $value: "1rem" },
      },
      radius: {
        sm: { $type: "dimension", $value: "0.25rem" },
      },
    } as ThemeDocument;
    const css = renderThemeCss(tokens);
    const namesFromCss = new Set<string>();
    for (const m of css.matchAll(/--[a-z0-9-]+/g)) namesFromCss.add(m[0]);
    const namesFromHelper = new Set(listThemeCssVarNames(tokens));
    expect(namesFromHelper).toEqual(namesFromCss);
  });

  it("returns names sorted (deterministic order for cache stability)", () => {
    const tokens: ThemeDocument = {
      color: {
        primary: { $type: "color", $value: "#000" },
        accent: { $type: "color", $value: "#fff" },
        muted: { $type: "color", $value: "#999" },
      },
    } as ThemeDocument;
    const names = listThemeCssVarNames(tokens);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
