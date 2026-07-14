// SPDX-License-Identifier: MPL-2.0

/**
 * issue #229 — LIST-mode crawler. When `urls` is present the crawl
 * fetches EXACTLY that set (+ the source origin), never expands via BFS,
 * and skips sitemap seeding — while every fetched page still runs the
 * same extraction pipeline as depth mode. Hermetic via injected fetchers.
 */

import { describe, expect, it } from "bun:test";
import { crawlSite, resolveListModeUrls } from "./crawler.js";

const page = (title: string, links: string[] = []): string =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

function makeSite(routes: Record<string, string>, texts: Record<string, string> = {}) {
  const fetched: string[] = [];
  return {
    fetched,
    fetcher: async (url: string) => {
      fetched.push(url);
      const path = new URL(url).pathname;
      const html = routes[path];
      if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
      return { ok: true, html, contentType: "text/html" };
    },
    textFetcher: async (url: string) => {
      const path = new URL(url).pathname;
      const body = texts[path];
      if (body === undefined) return { ok: false, body: "", contentType: "" };
      return { ok: true, body, contentType: "text/xml" };
    },
  };
}

describe("resolveListModeUrls (#229)", () => {
  it("prepends the source origin and preserves the chosen order", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://site.example/products",
      "https://site.example/blog/one",
    ]);
    expect(r.urls).toEqual([
      "https://site.example/",
      "https://site.example/products",
      "https://site.example/blog/one",
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("dedupes on the normalized key (hash + trailing slash stripped)", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://site.example/a/",
      "https://site.example/a",
      "https://site.example/a#section",
    ]);
    expect(r.urls).toEqual(["https://site.example/", "https://site.example/a"]);
  });

  it("strips ALL trailing slashes, not just one, before deduping", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://site.example/a//",
      "https://site.example/a///",
      "https://site.example/a/",
      "https://site.example/a",
    ]);
    expect(r.urls).toEqual(["https://site.example/", "https://site.example/a"]);
  });

  it("collapses a multi-slash root to the bare origin", () => {
    const r = resolveListModeUrls("https://site.example//", [
      "https://site.example///",
      "https://site.example/",
    ]);
    expect(r.urls).toEqual(["https://site.example/"]);
  });

  it("keeps distinct query strings as distinct pages", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://site.example/list?page=1",
      "https://site.example/list?page=2",
    ]);
    expect(r.urls).toEqual([
      "https://site.example/",
      "https://site.example/list?page=1",
      "https://site.example/list?page=2",
    ]);
  });

  it("does not duplicate the source when the list already contains it", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://site.example/",
      "https://site.example/x",
    ]);
    expect(r.urls).toEqual(["https://site.example/", "https://site.example/x"]);
  });

  it("drops off-origin and unparseable URLs into skipped (never fetched)", () => {
    const r = resolveListModeUrls("https://site.example/", [
      "https://evil.example/steal",
      "not a url",
      "https://site.example/keep",
    ]);
    expect(r.urls).toEqual(["https://site.example/", "https://site.example/keep"]);
    expect(r.skipped.map((s) => s.url)).toEqual(["https://evil.example/steal", "not a url"]);
    expect(r.skipped[0]?.reason).toContain("off-origin");
    expect(r.skipped[1]?.reason).toContain("unparseable");
  });
});

describe("crawlSite LIST mode (#229)", () => {
  it("fetches ONLY the given URLs (+ source), never BFS-expands their links", async () => {
    // Every page links to /trap; depth mode would follow it. List mode
    // must not.
    const site = makeSite({
      "/": page("Home", ["/products", "/blog", "/trap"]),
      "/products": page("Products", ["/trap", "/products/deep"]),
      "/blog/one": page("Blog One", ["/trap"]),
      "/trap": page("Trap"),
      "/products/deep": page("Deep"),
    });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/products", "https://site.example/blog/one"],
      fetcher: site.fetcher,
      textFetcher: site.textFetcher,
      throttleMs: 0,
    });
    const fetchedPaths = site.fetched.map((u) => new URL(u).pathname).sort();
    expect(fetchedPaths).toEqual(["/", "/blog/one", "/products"]);
    // /trap and /products/deep were linked but must never be fetched.
    expect(fetchedPaths).not.toContain("/trap");
    expect(fetchedPaths).not.toContain("/products/deep");
    const slugs = result.pages.map((p) => p.proposedSlug).sort();
    expect(slugs).toEqual(["blog-one", "home", "products"]);
  });

  it("runs the full per-page extraction on each fetched URL", async () => {
    const site = makeSite({
      "/": page("Home"),
      "/about": page("About Us"),
    });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/about"],
      fetcher: site.fetcher,
      throttleMs: 0,
    });
    const about = result.pages.find((p) => p.proposedSlug === "about");
    expect(about).toBeDefined();
    // Extraction pipeline ran: title + modules + signature all populated.
    expect(about?.title).toBe("About Us");
    expect(about?.modules.length).toBeGreaterThan(0);
    expect(about?.signature.length).toBeGreaterThan(0);
  });

  it("never seeds from the sitemap in list mode", async () => {
    const site = makeSite(
      {
        "/": page("Home"),
        "/chosen": page("Chosen"),
        "/sitemap-only": page("SitemapOnly"),
      },
      {
        "/sitemap.xml": `<urlset><url><loc>https://site.example/sitemap-only</loc></url></urlset>`,
      },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/chosen"],
      fetcher: site.fetcher,
      textFetcher: site.textFetcher,
      throttleMs: 0,
    });
    const slugs = result.pages.map((p) => p.proposedSlug).sort();
    expect(slugs).toEqual(["chosen", "home"]);
    expect(slugs).not.toContain("sitemap-only");
  });

  it("records off-origin list entries as errors and skips them", async () => {
    const site = makeSite({ "/": page("Home"), "/keep": page("Keep") });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/keep", "https://evil.example/x"],
      fetcher: site.fetcher,
      throttleMs: 0,
    });
    expect(site.fetched.every((u) => new URL(u).host === "site.example")).toBe(true);
    expect(result.errors.some((e) => e.reason.includes("off-origin"))).toBe(true);
  });

  it("still honours robots.txt Disallow in list mode", async () => {
    const site = makeSite(
      {
        "/": page("Home"),
        "/allowed": page("Allowed"),
        "/secret/x": page("Secret"),
      },
      { "/robots.txt": "User-agent: *\nDisallow: /secret/" },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/allowed", "https://site.example/secret/x"],
      fetcher: site.fetcher,
      textFetcher: site.textFetcher,
      throttleMs: 0,
    });
    const slugs = result.pages.map((p) => p.proposedSlug).sort();
    expect(slugs).toContain("allowed");
    expect(slugs).not.toContain("secret-x");
    expect(result.errors.some((e) => e.reason === "robots-disallowed")).toBe(true);
  });
});
