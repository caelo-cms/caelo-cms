// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — scoped crawling. The operator asks for ONE language or
 * section ("migrate the /de/ part"); the crawler must confine itself to
 * it: out-of-scope URLs are recorded as skipped — never fetched when the
 * prefix already rules them out — and hreflang alternates bridge to the
 * scope-locale version when a sample turns out to be the wrong language
 * (the 2026-08-04 searchviu dogfood failure). Hermetic via injected
 * fetchers.
 */

import { describe, expect, it } from "bun:test";
import { type CrawlCheckpoint, type CrawlFetchResult, crawlSite } from "./crawler.js";

const page = (title: string, links: string[] = [], head = ""): string =>
  `<html><head><title>${title}</title>${head}</head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

const hreflang = (entries: Record<string, string>): string =>
  Object.entries(entries)
    .map(([code, href]) => `<link rel="alternate" hreflang="${code}" href="${href}"/>`)
    .join("");

function makeSite(
  routes: Record<string, string>,
  opts: { redirects?: Record<string, string>; texts?: Record<string, string> } = {},
): {
  fetched: string[];
  fetcher: (url: string) => Promise<CrawlFetchResult>;
  textFetcher: (url: string) => Promise<{ ok: boolean; body: string; contentType: string }>;
} {
  const fetched: string[] = [];
  return {
    fetched,
    fetcher: async (url: string) => {
      fetched.push(url);
      const u = new URL(url);
      const finalPath = opts.redirects?.[u.pathname] ?? u.pathname;
      const html = routes[finalPath];
      if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
      return { ok: true, html, contentType: "text/html", finalUrl: `${u.origin}${finalPath}` };
    },
    textFetcher: async (url: string) => {
      const path = new URL(url).pathname;
      const body = opts.texts?.[path];
      if (body === undefined) return { ok: false, body: "", contentType: "" };
      return { ok: true, body, contentType: "text/xml" };
    },
  };
}

describe("path-prefix scope (#425)", () => {
  it("skips out-of-scope links without fetching them, and reports the scope", async () => {
    const site = makeSite({
      "/de/": page("Start", ["/de/about", "/en/about", "/pricing"]),
      "/de/about": page("Über uns"),
      "/en/about": page("About"),
      "/pricing": page("Pricing"),
    });
    let lastCheckpoint: CrawlCheckpoint | null = null;
    const result = await crawlSite({
      sourceUrl: "https://site.example/de/",
      depth: 2,
      maxPages: 10,
      throttleMs: 0,
      useSitemap: false,
      respectRobots: false,
      scope: { pathPrefix: "/de/" },
      fetcher: site.fetcher,
      onCheckpoint: async (cp) => {
        lastCheckpoint = cp;
      },
    });

    const fetchedPaths = site.fetched.map((u) => new URL(u).pathname).sort();
    expect(fetchedPaths).toEqual(["/de/", "/de/about"]);
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual(["about", "home"]);
    expect(result.skippedOutOfScope).toBe(2);
    expect(result.skipped.map((s) => new URL(s.url).pathname).sort()).toEqual([
      "/en/about",
      "/pricing",
    ]);
    for (const s of result.skipped) expect(s.reason).toContain("out-of-scope");
    expect(result.scope).toEqual({ pathPrefix: "/de/" });
    // The checkpoint carries the skip ledger so a resumed crawl keeps it.
    expect(lastCheckpoint!.skipped.length).toBe(2);
    expect(lastCheckpoint!.skippedOutOfScope).toBe(2);
  });

  it("filters sitemap seeds through the scope", async () => {
    const site = makeSite(
      {
        "/de/": page("Start"),
        "/de/blog/eins": page("Eins"),
        "/en/blog/one": page("One"),
      },
      {
        texts: {
          "/sitemap.xml": `<?xml version="1.0"?><urlset>
            <url><loc>https://site.example/de/blog/eins</loc></url>
            <url><loc>https://site.example/en/blog/one</loc></url>
          </urlset>`,
        },
      },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/de/",
      depth: 1,
      maxPages: 10,
      throttleMs: 0,
      respectRobots: false,
      scope: { pathPrefix: "/de" },
      fetcher: site.fetcher,
      textFetcher: site.textFetcher,
    });
    expect(site.fetched.map((u) => new URL(u).pathname).sort()).toEqual(["/de/", "/de/blog/eins"]);
    expect(result.skipped.some((s) => s.url.includes("/en/blog/one"))).toBe(true);
    expect(result.skippedOutOfScope).toBe(1);
  });

  it("drops a fetch whose redirect lands outside the scope, loudly", async () => {
    // LIST mode normalises the source root ("/de/" → "/de"), so the
    // fixture keys the root without the trailing slash.
    const site = makeSite(
      { "/de": page("Start"), "/en/moved": page("Moved") },
      { redirects: { "/de/moved": "/en/moved" } },
    );
    const result = await crawlSite({
      sourceUrl: "https://site.example/de/",
      urls: ["https://site.example/de/moved"],
      throttleMs: 0,
      scope: { pathPrefix: "/de/" },
      fetcher: site.fetcher,
    });
    expect(result.pages.map((p) => p.proposedSlug)).toEqual(["home"]);
    const skip = result.skipped.find((s) => s.url === "https://site.example/de/moved");
    expect(skip?.reason).toContain("redirected to https://site.example/en/moved");
    expect(result.skippedOutOfScope).toBe(1);
  });
});

describe("hreflang locale scope (#425, searchviu dogfood)", () => {
  it("skips a wrong-language sample and crawls its scope-locale alternate instead", async () => {
    // The dogfood failure shape: the German article lives at a ROOT-level
    // slug (no /de/ prefix a path rule could catch); the EN sample's own
    // hreflang names it. The crawl must store the German page, not the
    // EN one it was pointed at.
    const DE_PATH = "/google-search-console-daten-nach-bigquery-exportieren";
    const EN_PATH = "/en/google-search-console-data-bigquery";
    const site = makeSite({
      "/": page("Startseite", [], hreflang({ de: "https://searchviu.example/" })),
      [EN_PATH]: page(
        "GSC data to BigQuery",
        [],
        hreflang({
          en: `https://searchviu.example${EN_PATH}`,
          de: `https://searchviu.example${DE_PATH}`,
        }),
      ),
      [DE_PATH]: page(
        "GSC-Daten nach BigQuery",
        [],
        hreflang({
          de: `https://searchviu.example${DE_PATH}`,
          en: `https://searchviu.example${EN_PATH}`,
        }),
      ),
    });
    const result = await crawlSite({
      sourceUrl: "https://searchviu.example/",
      urls: [`https://searchviu.example${EN_PATH}`],
      throttleMs: 0,
      scope: { locale: "de" },
      fetcher: site.fetcher,
    });

    expect(result.pages.map((p) => p.url).sort()).toEqual([
      "https://searchviu.example/",
      `https://searchviu.example${DE_PATH}`,
    ]);
    const skip = result.skipped.find((s) => s.url === `https://searchviu.example${EN_PATH}`);
    expect(skip?.reason).toContain("wrong-locale");
    expect(skip?.reason).toContain(DE_PATH);
    expect(result.skippedOutOfScope).toBe(1);
    // The German page's slug derives from ITS OWN URL via the hardened
    // path — the root-level German slug survives verbatim.
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual([
      "google-search-console-daten-nach-bigquery-exportieren",
      "home",
    ]);
  });

  it("keeps pages whose hreflang set has no matching alternate (partial markup, no signal)", async () => {
    const site = makeSite({
      "/": page("Start"),
      "/artikel": page("Artikel", [], hreflang({ en: "https://site.example/en/article" })),
    });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/artikel"],
      throttleMs: 0,
      scope: { locale: "de" },
      fetcher: site.fetcher,
    });
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual(["artikel", "home"]);
    expect(result.skippedOutOfScope).toBe(0);
  });
});
