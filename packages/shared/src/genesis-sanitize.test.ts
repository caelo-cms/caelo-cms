// SPDX-License-Identifier: MPL-2.0

/**
 * issue #199 — sanitizeDraftHtml. Adversarial per CLAUDE.md §6:
 * operator-provided HTML becomes a stored draft that flows into
 * materialisation, so script removal must survive casing tricks,
 * multiple blocks, and unterminated tags.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeDraftHtml } from "./genesis.js";

describe("sanitizeDraftHtml (#199)", () => {
  it("strips script blocks, keeps everything else byte-identical", () => {
    const html = `<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Hi</h1></body></html>`;
    expect(sanitizeDraftHtml(html)).toBe(
      `<html><head><style>.a{color:red}</style></head><body><h1>Hi</h1></body></html>`,
    );
  });

  it("survives casing + attributes + multiple blocks", () => {
    const html = `<SCRIPT src="evil.js"></SCRIPT><p>a</p><ScRiPt type="module">fetch('/x')</ScRiPt><p>b</p>`;
    expect(sanitizeDraftHtml(html)).toBe(`<p>a</p><p>b</p>`);
  });

  it("an unterminated script drops to EOF rather than leaking half a payload", () => {
    const html = `<p>keep</p><script>document.cookie`;
    expect(sanitizeDraftHtml(html)).toBe(`<p>keep</p>`);
  });

  it("leaves script-free documents untouched", () => {
    const html = `<body><section class="description">javascript is a word, &lt;script&gt; is an entity</section></body>`;
    expect(sanitizeDraftHtml(html)).toBe(html);
  });
});
