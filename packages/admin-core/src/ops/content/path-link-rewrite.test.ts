// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — the pure link rewriter every page move uses.
 * Exact per path, one pass, trailing slash / query / fragment kept.
 */

import { describe, expect, it } from "bun:test";
import {
  buildPathMoveMap,
  rewritePathLinksInHtml,
  rewritePathLinksInJson,
  rewritePathValue,
} from "./path-link-rewrite.js";

const map = buildPathMoveMap([
  { from: "/alerts", to: "/seo-monitoring/alerts" },
  { from: "/alerts/email", to: "/seo-monitoring/alerts/email" },
]);

describe("rewritePathValue", () => {
  it("rewrites an exact path and keeps slash, query and fragment", () => {
    expect(rewritePathValue("/alerts", map)).toBe("/seo-monitoring/alerts");
    expect(rewritePathValue("/alerts/", map)).toBe("/seo-monitoring/alerts/");
    expect(rewritePathValue("/alerts#top", map)).toBe("/seo-monitoring/alerts#top");
    expect(rewritePathValue("/alerts?x=1", map)).toBe("/seo-monitoring/alerts?x=1");
  });

  it("leaves look-alikes and non-paths untouched", () => {
    expect(rewritePathValue("/alerts-old", map)).toBe("/alerts-old");
    expect(rewritePathValue("alerts", map)).toBe("alerts");
    expect(rewritePathValue("https://x.com/alerts", map)).toBe("https://x.com/alerts");
  });
});

describe("rewritePathLinksInHtml", () => {
  it("rewrites parent and child links in one pass without double-applying", () => {
    const html = `<a href="/alerts">A</a> <a href='/alerts/email'>E</a> <a href="/alerts-x">X</a>`;
    expect(rewritePathLinksInHtml(html, map)).toBe(
      `<a href="/seo-monitoring/alerts">A</a> <a href='/seo-monitoring/alerts/email'>E</a> <a href="/alerts-x">X</a>`,
    );
  });

  it("never rewrites links to the site root", () => {
    const rootMap = buildPathMoveMap([{ from: "/", to: "/old-home" }]);
    expect(rewritePathLinksInHtml(`<a href="/">Home</a>`, rootMap)).toBe(`<a href="/">Home</a>`);
  });
});

describe("rewritePathLinksInJson", () => {
  it("walks nested values and returns the same reference when unchanged", () => {
    const items = [{ label: "Alerts", href: "/alerts", children: [{ href: "/alerts/email" }] }];
    const next = rewritePathLinksInJson(items, map) as typeof items;
    expect(next[0]?.href).toBe("/seo-monitoring/alerts");
    expect(next[0]?.children[0]?.href).toBe("/seo-monitoring/alerts/email");
    const untouched = [{ href: "/pricing" }];
    expect(rewritePathLinksInJson(untouched, map)).toBe(untouched);
  });

  it("rewrites hrefs inside rich-text strings", () => {
    const v = { body: `<p>See <a href="/alerts">alerts</a></p>` };
    expect((rewritePathLinksInJson(v, map) as typeof v).body).toBe(
      `<p>See <a href="/seo-monitoring/alerts">alerts</a></p>`,
    );
  });
});
