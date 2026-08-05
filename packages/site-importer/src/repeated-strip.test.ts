// SPDX-License-Identifier: MPL-2.0

/**
 * issue #415 — single-page repeated-subtree dedup. Real-world shape this
 * guards: a carousel keeps clone slides in the DOM (testimonials appeared
 * 3x in the 2026-08-03 dogfood run's homepage Markdown); dedup keeps the
 * first occurrence and reports how many clones it removed.
 */

import { describe, expect, it } from "bun:test";
import { stripRepeatedSubtrees } from "./repeated-strip.js";

const SLIDE =
  '<div class="slide"><img src="/t.jpg" alt="t"><p>Great product, five stars from all of us</p></div>';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("stripRepeatedSubtrees", () => {
  it("keeps the FIRST carousel slide and removes the clones, counting them", () => {
    const html = `<main><h1>Testimonials</h1><div class="swiper">${SLIDE}${SLIDE}${SLIDE}</div><p>Unique closing paragraph stays.</p></main>`;
    const out = stripRepeatedSubtrees(html);
    expect(out.removed).toBe(2);
    expect(count(out.html, "Great product")).toBe(1);
    expect(out.html).toContain("Unique closing paragraph stays.");
    expect(out.html).toContain("Testimonials");
  });

  it("leaves structurally-similar blocks with DIFFERENT copy alone (real content)", () => {
    const html =
      "<section><h2>Alpha section heading here</h2><p>totally different body copy one</p></section>" +
      "<section><h2>Beta section heading here</h2><p>some other body copy number two</p></section>";
    const out = stripRepeatedSubtrees(html);
    expect(out.removed).toBe(0);
    expect(out.html).toBe(html);
  });

  it("ignores tiny text-less blocks below the qualifying gate", () => {
    const html = "<div><span>ok</span></div><div><span>ok</span></div><p>body</p>";
    const out = stripRepeatedSubtrees(html);
    expect(out.removed).toBe(0);
    expect(out.html).toBe(html);
  });

  it("merges nested duplicates so each removed block counts once", () => {
    // A section containing two identical cards, and the whole section
    // duplicated: expected removals = the sibling card inside the surviving
    // section (1) + the whole cloned section (1, its inner card duplicates
    // are contained in its range) = 2.
    const card = '<div class="card"><a href="/x">Card link text here we go now</a></div>';
    const section = `<section class="dup">${card}${card}</section>`;
    const out = stripRepeatedSubtrees(`<main>${section}${section}</main>`);
    expect(out.removed).toBe(2);
    expect(count(out.html, "Card link text")).toBe(1);
  });

  it("finds clones nested deeper than the crawl walker's 8-frame cap (page-builder div-soup)", () => {
    // 10 nested block wrappers put the slides at open-frame depth ~11 — the
    // crawl default (8) would never record them; the single-page walk must.
    const open = "<div>".repeat(10);
    const close = "</div>".repeat(10);
    const out = stripRepeatedSubtrees(`${open}<div class="swiper">${SLIDE}${SLIDE}</div>${close}`);
    expect(out.removed).toBe(1);
    expect(count(out.html, "Great product")).toBe(1);
  });

  it("byte-range removal leaves the surviving markup byte-identical", () => {
    const html = `<main><p>before</p>${SLIDE}<p>between</p>${SLIDE}<p>after</p></main>`;
    const out = stripRepeatedSubtrees(html);
    expect(out.removed).toBe(1);
    // Everything except the second slide's exact byte range survives as-is.
    expect(out.html).toBe(`<main><p>before</p>${SLIDE}<p>between</p><p>after</p></main>`);
  });
});
