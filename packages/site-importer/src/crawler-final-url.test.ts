// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — final-URL persistence. The dogfood run stored a sample
 * under the URL that was REQUESTED, not the URL the server actually
 * served after redirecting — slugs and redirect planning then started
 * from a page that doesn't exist. These tests pin: pages are stored
 * under their FINAL URL, the requested URL survives as provenance, the
 * slug goes through the hardened urlToSlug prefix strip (run #9 — never
 * a blind slice), and redirect duplicates are reported, not re-stored.
 */

import { describe, expect, it } from "bun:test";
import { type CrawlFetchResult, crawlSite } from "./crawler.js";

/** Fixture site: path → html, with optional per-path redirects. The
 *  fetcher reports `finalUrl` exactly like the real fetchers do. */
function makeSite(
  routes: Record<string, string>,
  redirects: Record<string, string> = {},
): { fetched: string[]; fetcher: (url: string) => Promise<CrawlFetchResult> } {
  const fetched: string[] = [];
  return {
    fetched,
    fetcher: async (url: string) => {
      fetched.push(url);
      const u = new URL(url);
      const finalPath = redirects[u.pathname] ?? u.pathname;
      const html = routes[finalPath];
      if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
      return {
        ok: true,
        html,
        contentType: "text/html",
        finalUrl: `${u.origin}${finalPath}`,
      };
    },
  };
}

const page = (title: string, links: string[] = []): string =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

describe("final-URL persistence (#425)", () => {
  it("stores a redirected page under its final URL with the requested URL as provenance", async () => {
    const site = makeSite(
      { "/": page("Home"), "/new-post": page("New Post") },
      { "/old-post": "/new-post" },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/old-post"],
      throttleMs: 0,
      fetcher: site.fetcher,
    });
    const post = result.pages.find((p) => p.proposedSlug === "new-post");
    expect(post?.url).toBe("https://site.example/new-post");
    expect(post?.requestedUrl).toBe("https://site.example/old-post");
    expect(result.errors).toEqual([]);
  });

  it("derives the slug from the FINAL URL through the hardened prefix strip (run #9)", async () => {
    // Crawl rooted at /en/; the redirect lands OUTSIDE the /en prefix.
    // The hardened urlToSlug must keep the full pathname — "tools",
    // never the blind-slice mangle "ols".
    const site = makeSite(
      { "/en": page("Home EN"), "/tools": page("Tools") },
      { "/en/tools": "/tools" },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/en/",
      urls: ["https://site.example/en/tools"],
      throttleMs: 0,
      fetcher: site.fetcher,
    });
    const tools = result.pages.find((p) => p.url === "https://site.example/tools");
    expect(tools?.proposedSlug).toBe("tools");
    expect(tools?.requestedUrl).toBe("https://site.example/en/tools");
  });

  it("a fetcher without finalUrl means no redirect — no provenance recorded", async () => {
    const fetched: string[] = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/about"],
      throttleMs: 0,
      fetcher: async (url: string) => {
        fetched.push(url);
        return { ok: true, html: page("Plain"), contentType: "text/html" };
      },
    });
    for (const p of result.pages) expect(p.requestedUrl).toBeUndefined();
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual(["about", "home"]);
  });

  it("reports a redirect onto an already-crawled page as a skip, never a duplicate row", async () => {
    const site = makeSite({ "/": page("Home", ["/a", "/b"]), "/a": page("A") }, { "/b": "/a" });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      depth: 1,
      maxPages: 10,
      throttleMs: 0,
      concurrency: 1,
      useSitemap: false,
      respectRobots: false,
      fetcher: site.fetcher,
    });
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual(["a", "home"]);
    const dup = result.skipped.find((s) => s.url === "https://site.example/b");
    expect(dup?.reason).toContain("redirect-duplicate");
    // A duplicate is not an out-of-scope skip — the counter stays 0.
    expect(result.skippedOutOfScope).toBe(0);
  });

  it("keeps the crawl root as the home anchor even when the source redirects", async () => {
    const site = makeSite({ "/de": page("Startseite") }, { "/": "/de" });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      depth: 1,
      maxPages: 5,
      throttleMs: 0,
      useSitemap: false,
      respectRobots: false,
      fetcher: site.fetcher,
    });
    const home = result.pages[0];
    expect(home?.url).toBe("https://site.example/de");
    expect(home?.requestedUrl).toBe("https://site.example/");
    expect(home?.proposedSlug).toBe("home");
    expect(home?.signature).toBe("home");
  });
});
