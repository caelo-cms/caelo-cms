// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for the extractor hardening (issue #113):
 *   - S4 js/polynomial-redos: the <title>/<style>/:root{ extractors and the
 *     <body> slice now use tempered-dot bodies — bound the worst case.
 *   - S6 js/double-escaping: decodeEntities (exercised via extractTitle)
 *     decodes &amp; LAST so &amp;lt; no longer double-unescapes to a live <.
 */

import { describe, expect, it } from "bun:test";
import { extractModulesFromHtml, extractThemeTokens, extractTitle } from "./extractor.js";

// Generous bound: a linear regex finishes a 100k-char scan in tens of ms even
// on a slow CI runner, while the O(n²) backtracking this guards against would
// take many seconds on the same input — so 1s cleanly separates the two
// without flaking on runner-speed variance.
const BUDGET_MS = 1000;
const N = 100_000;

function underBudget(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("extractor ReDoS termination (S4)", () => {
  it("extractTitle bounds an unclosed <title> with a huge body", () => {
    const evil = `<title>${"a".repeat(N)}`;
    expect(underBudget(() => extractTitle(evil))).toBeLessThan(BUDGET_MS);
  });

  it("extractThemeTokens bounds unclosed <style> / :root { with huge bodies", () => {
    const evilStyle = `<style>${"a".repeat(N)}`;
    const evilRoot = `<style>:root{${"a".repeat(N)}</style>`;
    expect(underBudget(() => extractThemeTokens(evilStyle))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractThemeTokens(evilRoot))).toBeLessThan(BUDGET_MS);
  });

  it("sliceBody scans a huge body text linearly", () => {
    // Isolates the hardened sliceBody regex: a large plain-text body with no
    // section tags. (Deeply-nested-tag cost lives in htmlparser2, not the
    // regex this fix touched, so the input is intentionally tag-light.)
    const big = `<body>${"a".repeat(N)}</body>`;
    expect(underBudget(() => extractModulesFromHtml(big))).toBeLessThan(BUDGET_MS);
  });

  it("open-tag scan is linear on a stream of repeated open tags", () => {
    // The real polynomial was the open tag `<title[^>]*>` whose `[^>]*` spanned
    // `<`: a `<title<title<title…` stream drove O(n²) unanchored retries. The
    // `[^<>]*` opening makes each retry fail in O(1). These must stay fast.
    expect(underBudget(() => extractTitle("<title".repeat(N)))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractThemeTokens("<style".repeat(N)))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractModulesFromHtml("<body".repeat(N)))).toBeLessThan(BUDGET_MS);
  });
});

describe("extractor behaviour-equivalence (S4)", () => {
  it("extractTitle returns the title text on well-formed input", () => {
    expect(extractTitle("<title>Hello World</title>")).toBe("Hello World");
  });

  it("extractThemeTokens parses :root declarations", () => {
    const tokens = extractThemeTokens("<style>:root{ --primary: #ff0000; --gap: 8px; }</style>");
    expect(tokens["--primary"]).toBe("#ff0000");
    expect(tokens["--gap"]).toBe("8px");
  });
});

describe("decodeEntities ordering (S6 double-escaping)", () => {
  it("decodes &amp; LAST so &amp;lt; does not become a live <", () => {
    expect(extractTitle("<title>&amp;lt;</title>")).toBe("&lt;");
  });

  it("still single-decodes real entities", () => {
    expect(extractTitle("<title>&lt;script&gt;</title>")).toBe("<script>");
    expect(extractTitle("<title>Tom &amp; Jerry</title>")).toBe("Tom & Jerry");
  });
});
