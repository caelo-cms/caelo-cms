// SPDX-License-Identifier: MPL-2.0

/**
 * Regression test for the CSS-token sanitizer (issue #113, S6 —
 * js/incomplete-multi-character-sanitization + js/bad-tag-filter). A
 * free-form typography fontFamily value must not be able to break out of
 * the surrounding <style> block: `</style`, `<!--`, `-->`, and the HTML5
 * alternative comment-close `--!>` are all scrubbed, idempotently.
 */

import { describe, expect, it } from "bun:test";
import { renderThemeCss } from "./theme-render.js";
import type { ThemeDocument } from "./themes.js";

function fontDoc(fontFamily: string): ThemeDocument {
  return {
    typography: { body: { $value: { fontFamily }, $type: "typography" } },
  } as unknown as ThemeDocument;
}

describe("renderThemeCss CSS-token sanitization (S6)", () => {
  it("scrubs a </style> breakout from a fontFamily value", () => {
    const css = renderThemeCss(fontDoc("Inter</style><script>alert(1)</script>"));
    expect(css.toLowerCase()).not.toContain("</style");
  });

  it("scrubs CDO/CDC comment tokens including the --!> variant", () => {
    const css = renderThemeCss(fontDoc("a<!--b-->c--!>d"));
    expect(css).not.toContain("<!--");
    expect(css).not.toContain("-->");
    expect(css).not.toContain("--!>");
  });

  it("handles a re-creation fixture (sequential removal can't re-expose a token)", () => {
    const css = renderThemeCss(fontDoc("<!--</style>-->"));
    expect(css.toLowerCase()).not.toContain("</style");
    expect(css).not.toContain("<!--");
    expect(css).not.toContain("-->");
  });

  it("leaves a normal fontFamily untouched", () => {
    const css = renderThemeCss(fontDoc("Inter, sans-serif"));
    expect(css).toContain("Inter, sans-serif");
  });

  it("scrubs </style> from string shadow tokens", () => {
    const doc = {
      shadow: {
        card: { $value: "0 2px 4px #000</style><script>alert(1)</script>", $type: "shadow" },
      },
    } as unknown as ThemeDocument;
    const css = renderThemeCss(doc);
    expect(css.toLowerCase()).not.toContain("</style");
  });

  it("rejects selectors containing CSS block delimiters or </style>", () => {
    expect(() => renderThemeCss(fontDoc("Inter"), { selector: ":root{color:red}body" })).toThrow(
      /Invalid CSS selector/,
    );
    expect(() => renderThemeCss(fontDoc("Inter"), { selector: "</style><script>" })).toThrow(
      /Invalid CSS selector/,
    );
  });

  it("skips token keys containing characters outside CSS custom property identifiers", () => {
    const doc = {
      color: {
        "primary;--x:1}</style><script>": { $type: "color", $value: "#000" },
        valid: { $type: "color", $value: "#fff" },
      },
    } as unknown as ThemeDocument;
    const css = renderThemeCss(doc);
    expect(css.toLowerCase()).not.toContain("</style");
    expect(css).toContain("--color-valid:#fff;");
  });
});
