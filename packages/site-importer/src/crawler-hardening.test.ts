// SPDX-License-Identifier: MPL-2.0

/**
 * issue #192 — crawler hardening: sitemap seeding, robots.txt honor,
 * checkpoint/resume, batched streaming, and the 1500-page scale case.
 * All hermetic via injected fetchers (the SSRF/network layer has its
 * own suite in safe-fetch.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { type CrawlCheckpoint, type CrawledPage, crawlSite, USER_AGENT } from "./crawler.js";
import { isPathAllowed, parseRobotsTxt } from "./robots.js";
import { discoverSitemapUrls, extractLocValues } from "./sitemap.js";

const page = (title: string, links: string[] = []): string =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

/** Minimal site harness: maps path → html, counts fetches. */
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

describe("robots.txt parsing (#192)", () => {
  const txt = [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /private/",
    "Allow: /private/press",
    "Crawl-delay: 2",
    "",
    "User-agent: CaleoSiteImporter",
    "Disallow: /no-caelo",
    "",
    "Sitemap: https://site.example/sitemap-news.xml",
  ].join("\n");

  it("prefers the specific UA group over *", () => {
    const rules = parseRobotsTxt(txt, "caleositeimporter");
    expect(rules.disallow).toEqual(["/no-caelo"]);
    expect(rules.crawlDelayMs).toBeNull();
    expect(rules.sitemaps).toEqual(["https://site.example/sitemap-news.xml"]);
  });

  it("falls back to * with crawl-delay and allow-overrides", () => {
    const rules = parseRobotsTxt(txt, "someotherbot");
    expect(rules.crawlDelayMs).toBe(2000);
    expect(isPathAllowed(rules, "/admin/panel")).toBe(false);
    expect(isPathAllowed(rules, "/private/docs")).toBe(false);
    expect(isPathAllowed(rules, "/private/press-release")).toBe(true);
    expect(isPathAllowed(rules, "/products")).toBe(true);
  });

  it("no matching group = everything allowed", () => {
    const rules = parseRobotsTxt("User-agent: googlebot\nDisallow: /", "caleositeimporter");
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
});

describe("sitemap discovery (#192)", () => {
  it("extractLocValues is linear and capped", () => {
    const xml = "<urlset>" + "<url><loc>https://a.example/x</loc></url>".repeat(10) + "</urlset>";
    expect(extractLocValues(xml, 3)).toHaveLength(3);
  });

  it("follows a sitemap index one level, drops cross-host, dedupes", async () => {
    const { textFetcher } = makeSite(
      {},
      {
        "/sitemap.xml": `<sitemapindex><sitemap><loc>https://site.example/sm-a.xml</loc></sitemap><sitemap><loc>https://site.example/sm-b.xml</loc></sitemap></sitemapindex>`,
        "/sm-a.xml": `<urlset><url><loc>https://site.example/one</loc></url><url><loc>https://evil.example/two</loc></url></urlset>`,
        "/sm-b.xml": `<urlset><url><loc>https://site.example/one</loc></url><url><loc>https://site.example/three/</loc></url></urlset>`,
      },
    );
    const d = await discoverSitemapUrls({
      origin: "https://site.example",
      fetcher: textFetcher,
      maxUrls: 100,
    });
    expect([...d.urls].sort()).toEqual(["https://site.example/one", "https://site.example/three"]);
  });
});

describe("crawl with sitemap + robots (#192)", () => {
  it("crawls sitemap-listed pages that no link reaches; skips robots-disallowed paths", async () => {
    const site = makeSite(
      {
        "/": page("Home", ["/linked"]),
        "/linked": page("Linked"),
        "/hidden-landing": page("Hidden"), // only in the sitemap
        "/secret/x": page("Secret"), // robots-disallowed
      },
      {
        "/robots.txt": "User-agent: *\nDisallow: /secret/",
        "/sitemap.xml": `<urlset><url><loc>https://site.example/hidden-landing</loc></url><url><loc>https://site.example/secret/x</loc></url></urlset>`,
      },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: site.fetcher,
      textFetcher: site.textFetcher,
      throttleMs: 0,
      maxPages: 50,
    });
    const slugs = result.pages.map((p) => p.proposedSlug).sort();
    expect(slugs).toContain("hidden-landing");
    expect(slugs).toContain("linked");
    expect(slugs).not.toContain("secret-x");
    expect(result.errors.some((e) => e.reason === "robots-disallowed")).toBe(true);
  });
});

describe("streaming + checkpoint/resume (#192)", () => {
  const routes: Record<string, string> = {
    "/": page(
      "Home",
      Array.from({ length: 9 }, (_, i) => `/p${i}`),
    ),
  };
  for (let i = 0; i < 9; i++) routes[`/p${i}`] = page(`P${i}`);

  it("onBatch streams chunks and result.pages stays empty", async () => {
    const site = makeSite(routes);
    const batches: CrawledPage[][] = [];
    const checkpoints: CrawlCheckpoint[] = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: site.fetcher,
      throttleMs: 0,
      maxPages: 50,
      batchSize: 4,
      onBatch: async (b) => {
        batches.push(b);
      },
      onCheckpoint: async (cp) => {
        checkpoints.push(structuredClone(cp));
      },
    });
    expect(result.pages).toHaveLength(0);
    expect(result.pagesCrawled).toBe(10);
    expect(batches.flat()).toHaveLength(10);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    // Every checkpoint's counters are consistent.
    for (const cp of checkpoints) {
      expect(cp.seen.length).toBeGreaterThanOrEqual(cp.pagesCrawled);
    }
  });

  it("resumeFrom continues without re-fetching already-seen URLs", async () => {
    const siteA = makeSite(routes);
    const checkpoints: CrawlCheckpoint[] = [];
    await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: siteA.fetcher,
      throttleMs: 0,
      maxPages: 50,
      batchSize: 3,
      onBatch: async () => {},
      onCheckpoint: async (cp) => {
        checkpoints.push(structuredClone(cp));
      },
    });
    // Pretend the worker died right after the FIRST checkpoint.
    const mid = checkpoints[0];
    if (!mid) throw new Error("no checkpoint captured");
    expect(mid.pagesCrawled).toBeLessThan(10);

    const siteB = makeSite(routes);
    const resumed = await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: siteB.fetcher,
      throttleMs: 0,
      maxPages: 50,
      resumeFrom: mid,
    });
    // Completed the site: the counter continues from the checkpoint,
    // and this run only fetched the remainder.
    expect(resumed.pagesCrawled).toBe(10);
    expect(resumed.pages.length).toBe(10 - mid.pagesCrawled);
    // …and never re-fetched what the first worker already crawled.
    for (const seenUrl of mid.seen) {
      expect(siteB.fetched).not.toContain(seenUrl);
    }
  });
});

describe("scale (#192)", () => {
  it("crawls a 1500-page synthetic site to completion under the raised cap", async () => {
    const bigRoutes: Record<string, string> = {};
    // Hub-and-chunk topology: root links 30 hubs, each hub links 50 leaves.
    const hubs = Array.from({ length: 30 }, (_, h) => `/hub${h}`);
    bigRoutes["/"] = page("Home", hubs);
    for (let h = 0; h < 30; h++) {
      const leaves = Array.from({ length: 50 }, (_, l) => `/hub${h}/leaf${l}`);
      bigRoutes[`/hub${h}`] = page(`Hub ${h}`, leaves);
      for (const leaf of leaves) bigRoutes[leaf] = page(leaf);
    }
    let streamed = 0;
    const site = makeSite(bigRoutes);
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      fetcher: site.fetcher,
      throttleMs: 0,
      depth: 3,
      maxPages: 2000,
      batchSize: 100,
      onBatch: async (b) => {
        streamed += b.length;
      },
    });
    expect(result.pagesCrawled).toBe(1531); // 1 + 30 + 1500
    expect(streamed).toBe(1531);
    expect(result.pages).toHaveLength(0); // memory stayed out of the result
  });
});

describe("crawler UA header (#200 determinism run finding)", () => {
  it("USER_AGENT is pure ASCII — header values reject anything else at the socket layer", () => {
    for (const ch of USER_AGENT) {
      expect(ch.charCodeAt(0), `non-ASCII char '${ch}' in USER_AGENT`).toBeLessThan(128);
    }
  });
});
