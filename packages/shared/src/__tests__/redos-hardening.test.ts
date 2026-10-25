// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for the polynomial-ReDoS hardening (issue #113, S4).
 * Two assertion classes per rewritten pattern:
 *   - termination bound: a pathological input completes well under a hard
 *     budget (a quadratic regex blows it by orders of magnitude, so the
 *     threshold is not flaky);
 *   - behaviour equivalence: the hardened form produces the same output as
 *     the documented intent on valid input.
 */

import { describe, expect, it } from "bun:test";
import { fontFamilySlug, parseFontsCss } from "../fonts.js";
import { DEFAULT_LIST_TYPES } from "../lists/default-types.js";
import { createListRenderContext } from "../lists/resolve.js";
import { renderTemplate } from "../template-engine.js";
import { stripCssComments } from "../theme-importers/css-comments.js";
import { trimSlashes, trimTrailingSlashes } from "../url.js";

// 250ms, not 100: under CI coverage instrumentation on a loaded runner
// the LINEAR 100k-char scans measured up to ~113ms (PR #170 flake). A
// quadratic regression blows this by orders of magnitude (seconds), so
// the wider bound loses no detection power — it only stops punishing
// slow runners for being slow.
const BUDGET_MS = 250;

function underBudget(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("trimSlashes / trimTrailingSlashes (S4)", () => {
  it("terminates linearly on a long slash run not at end-of-string", () => {
    const evil = `${"/".repeat(200_000)}x`;
    expect(underBudget(() => trimSlashes(evil))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => trimTrailingSlashes(evil))).toBeLessThan(BUDGET_MS);
  });

  it("is behaviour-equivalent to the old trims on valid input", () => {
    expect(trimSlashes("//a/b//")).toBe("a/b");
    expect(trimSlashes("a/b")).toBe("a/b");
    expect(trimSlashes("///")).toBe("");
    expect(trimSlashes("")).toBe("");
    // base-URL case: trailing-only trim keeps the scheme's slashes.
    expect(trimTrailingSlashes("https://example.com/")).toBe("https://example.com");
    expect(trimTrailingSlashes("https://example.com///")).toBe("https://example.com");
  });
});

describe("stripCssComments (S4)", () => {
  it("terminates on a flood of unterminated comment openers", () => {
    const evil = "/*".repeat(100_000);
    expect(underBudget(() => stripCssComments(evil))).toBeLessThan(BUDGET_MS);
  });

  it("strips real comments and leaves non-comment text", () => {
    expect(stripCssComments("a /* x */ b")).toBe("a  b");
    expect(stripCssComments("color: red;")).toBe("color: red;");
  });
});

describe("renderTemplate sections (S4, epic #1107 tokenizer)", () => {
  const lists = createListRenderContext({
    listTypes: new Map(DEFAULT_LIST_TYPES.map((t) => [t.slug, { id: t.slug, def: t }])),
    lists: new Map(),
    pageTypes: new Map(),
    pages: new Map(),
    media: new Map(),
    siteLanguage: "en",
  }).forPage(null);
  const navField = { name: "nav_items", kind: "list" as const, listType: "links" };
  const entry = (n: number, label: string, href: string) => ({
    id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
    node: "link",
    values: { label, link: { href } },
  });

  it("scans a large closed section body linearly (no quadratic backtracking)", () => {
    // A closed section with a 100k-char literal body: the section pass
    // tokenizes once and pairs tags with a stack, no regex over the body.
    const big = "x".repeat(100_000);
    const html = `<nav>{{#nav_items}}${big}<a href="{{link}}">{{label}}</a>{{/nav_items}}</nav>`;
    expect(
      underBudget(() =>
        renderTemplate({
          html,
          fields: [navField],
          contentValues: { nav_items: [entry(1, "Docs", "/docs")] },
          lists,
        }),
      ),
    ).toBeLessThan(BUDGET_MS);
  });

  it("thousands of unclosed sections cost one pass, not one scan each", () => {
    // Unclosed opens stay unpaired (the later Mustache pass reports them);
    // pairing must not rescan the rest of the document per open.
    const html = "{{#a}}".repeat(5_000) + "x".repeat(50_000);
    expect(
      underBudget(() => {
        try {
          renderTemplate({
            html,
            fields: [{ name: "a", kind: "text" }],
            contentValues: { a: "1" },
          });
        } catch {
          // Mustache refuses the unclosed sections; only the cost matters here.
        }
      }),
    ).toBeLessThan(BUDGET_MS);
  });

  it("still iterates a closed section the same way", () => {
    const out = renderTemplate({
      html: '<nav>{{#nav_items}}<a href="{{link}}">{{label}}</a>{{/nav_items}}</nav>',
      fields: [navField],
      contentValues: { nav_items: [entry(1, "Docs", "/docs"), entry(2, "Blog", "/blog")] },
      lists,
    });
    expect(out.html.replace(/ data-caelo-list-item="[^"]*"/g, "")).toBe(
      '<nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>',
    );
  });
});

describe("fonts.ts patterns (issue #150 CodeQL follow-up)", () => {
  it("scans a payload of unclosed @font-face starts linearly", () => {
    // [^{}]* aborts at the next `{`; the old [^}]* rescanned to EOF per
    // start position (quadratic across matchAll).
    const evil = "@font-face{".repeat(30_000);
    expect(underBudget(() => parseFontsCss(evil))).toBeLessThan(BUDGET_MS);
  });

  it("scans an ambiguous url( run linearly and rejects oversized payloads", () => {
    const evil = `@font-face{font-family:'X';src:${"url((".repeat(20_000)};}`;
    expect(underBudget(() => parseFontsCss(evil))).toBeLessThan(BUDGET_MS);
    expect(parseFontsCss(`x${"y".repeat(1_000_001)}`)).toEqual([]);
  });

  it("still parses a valid css2 block identically (behaviour equivalence)", () => {
    const faces = parseFontsCss(
      "@font-face{font-family:'Poppins';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/a.woff2) format('woff2');unicode-range:U+0000-00FF;}",
    );
    expect(faces).toEqual([
      {
        family: "Poppins",
        style: "normal",
        weight: "400",
        unicodeRange: "U+0000-00FF",
        srcUrl: "https://fonts.gstatic.com/a.woff2",
      },
    ]);
  });

  it("slugs an all-dash family name linearly (no -+$ backtracking)", () => {
    const evil = "-".repeat(200_000);
    expect(underBudget(() => fontFamilySlug(evil))).toBeLessThan(BUDGET_MS);
    expect(fontFamilySlug("  Playfair Display  ")).toBe("playfair-display");
    expect(fontFamilySlug("--Weird--Name--")).toBe("weird-name");
  });
});

describe("css gradient scanner + binding decl parse (issue #164 CodeQL follow-up)", () => {
  it("scans a wall of unclosed gradient heads linearly", async () => {
    const { scanCssGradients } = await import("../css-gradient-scan.js");
    const evil = "conic-gradient(".repeat(20_000);
    expect(underBudget(() => scanCssGradients(evil))).toBeLessThan(BUDGET_MS);
    expect(scanCssGradients(evil)).toEqual([]);
  });

  it("still extracts nested-paren gradients correctly (behaviour equivalence)", async () => {
    const { scanCssGradients } = await import("../css-gradient-scan.js");
    const css =
      "a{background:linear-gradient(135deg, rgba(15,23,42,0.5), #fff)} b{x:repeating-linear-gradient(45deg, #000 0 2px)}";
    const found = scanCssGradients(css).map((m) => m.literal);
    expect(found).toEqual([
      "linear-gradient(135deg, rgba(15,23,42,0.5), #fff)",
      "repeating-linear-gradient(45deg, #000 0 2px)",
    ]);
  });

  it("builds the theme value map linearly on adversarial dash runs", async () => {
    const { buildThemeValueMap } = await import("../theme-literal-binding.js");
    const tokens = {
      color: { primary: { $type: "color", $value: "#4f46e5" } },
    } as unknown as import("../themes.js").ThemeDocument;
    // The map parse consumes renderer OUTPUT, but harden the parse
    // itself against pathological documents producing long dash names.
    expect(underBudget(() => buildThemeValueMap(tokens))).toBeLessThan(BUDGET_MS);
  });
});
