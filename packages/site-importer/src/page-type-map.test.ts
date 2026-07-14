// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type ClassifierLink, classifyPageTypes } from "./page-type-map.js";

const H = "https://example.com";

/** searchviu-like homepage: real types in nav + footer, noise in sitemap. */
const navFooter: ClassifierLink[] = [
  { href: `${H}/en/pricing`, text: "Pricing", location: "nav" },
  { href: `${H}/en/blog`, text: "Blog", location: "nav" },
  { href: `${H}/en/use-cases`, text: "Use Cases", location: "nav" },
  { href: `${H}/de/preise`, text: "Preise", location: "nav" }, // other locale
  { href: `${H}/en/`, text: "Home", location: "nav" },
  { href: "https://twitter.com/x", text: "Follow", location: "nav" },
  { href: `${H}/en/impressum`, text: "Impressum", location: "footer" },
  { href: `${H}/en/privacy`, text: "Privacy", location: "footer" },
  { href: `${H}/en/pricing`, text: "See plans", location: "body" }, // body ignored
];

const sitemap = [
  `${H}/en/blog/post-1`,
  `${H}/en/blog/post-2`,
  `${H}/en/tools/keyword-checker`,
  `${H}/en/tag/seo`,
  `${H}/en/category/news`,
  `${H}/en/2023/05/old-post`,
  `${H}/en/author/jane`,
  `${H}/en/blog/page/2`,
  `${H}/de/blog/fremd`,
];

describe("classifyPageTypes", () => {
  const map = classifyPageTypes({
    siteUrl: `${H}/en`,
    links: navFooter,
    sitemapUrls: sitemap,
  });
  const byType = new Map(map.types.map((t) => [t.section, t]));

  it("detects the active locale from the migrated URL", () => {
    expect(map.activeLocale).toBe("en");
  });

  it("names single nav pages from their anchor label", () => {
    const pricing = byType.get("pricing");
    expect(pricing?.type).toBe("pricing");
    expect(pricing?.source).toBe("nav");
    expect(pricing?.collection).toBe(false);
    expect(pricing?.sampleUrl).toBe(`${H}/en/pricing`);
    expect(pricing?.evidence).toContain('nav label "Pricing"');
  });

  it("collapses many /blog/* into ONE collection type with an item sample", () => {
    const blog = byType.get("blog");
    expect(blog?.type).toBe("blog-article");
    expect(blog?.collection).toBe(true);
    // nav index + 2 sitemap posts = 3 members (pagination filtered out).
    expect(blog?.memberCount).toBe(3);
    expect(blog?.sampleUrl).toBe(`${H}/en/blog/post-1`);
    expect(blog?.evidence).toContain("3 pages under /blog/");
  });

  it("filters archive/tag/date/author/pagination + other-locale noise", () => {
    const reasons = map.filtered.map((f) => f.reason);
    expect(map.filtered.some((f) => f.url.includes("/tag/seo"))).toBe(true);
    expect(map.filtered.some((f) => f.url.includes("/category/news"))).toBe(true);
    expect(map.filtered.some((f) => f.url.includes("/author/jane"))).toBe(true);
    expect(reasons).toContain("date archive");
    expect(reasons).toContain("pagination");
    expect(reasons.some((r) => r.startsWith("other-locale"))).toBe(true);
    // None of the noise leaked into a page type.
    expect(map.types.some((t) => ["tag", "category", "author", "2023"].includes(t.section))).toBe(
      false,
    );
    // The /de/* links never became types.
    expect(map.types.some((t) => t.sampleUrl.includes("/de/"))).toBe(false);
  });

  it("ignores body-located links (nav + footer + sitemap only)", () => {
    // "See plans" is a body link; pricing must be sourced from nav, not body.
    expect(byType.get("pricing")?.source).toBe("nav");
  });

  it("orders types nav-first, then footer, then sitemap-only", () => {
    const sources = map.types.map((t) => t.source);
    const firstFooter = sources.indexOf("footer");
    const firstSitemap = sources.indexOf("sitemap");
    const lastNav = sources.lastIndexOf("nav");
    expect(lastNav).toBeLessThan(firstFooter);
    if (firstSitemap !== -1) expect(firstFooter).toBeLessThan(firstSitemap);
    // tools is sitemap-only and last.
    expect(byType.get("tools")?.source).toBe("sitemap");
  });

  it("keeps footer legal pages as their own single types", () => {
    expect(byType.get("impressum")?.type).toBe("impressum");
    expect(byType.get("privacy")?.source).toBe("footer");
  });

  it("works with no sitemap (nav+footer only) and no locale prefix", () => {
    const map2 = classifyPageTypes({
      siteUrl: H,
      links: [{ href: `${H}/products`, text: "Products", location: "nav" }],
    });
    expect(map2.activeLocale).toBe("");
    expect(map2.types[0]?.section).toBe("products");
  });
});
