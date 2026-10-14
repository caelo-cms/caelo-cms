// SPDX-License-Identifier: MPL-2.0

/**
 * The crawl keeps each source page's meta description. The searchviu.com
 * migration lost every one of them (the crawler parsed it for hreflang
 * only), so the rebuilt pages went live without descriptions. The rebuild
 * now carries `CrawledPage.metaDescription` over via autofill_page_seo_many.
 */

import { describe, expect, it } from "bun:test";
import { type CrawlFetchResult, crawlSite } from "./crawler.js";

const routes: Record<string, string> = {
  "/": `<html><head><title>Home</title><meta name="description" content="Crawl budget analytics for large sites."></head><body><a href="/plain">Plain</a></body></html>`,
  "/plain":
    "<html><head><title>Plain</title></head><body><p>No description here.</p></body></html>",
};

async function fetcher(url: string): Promise<CrawlFetchResult> {
  const u = new URL(url);
  const html = routes[u.pathname];
  if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
  return { ok: true, html, contentType: "text/html", finalUrl: `${u.origin}${u.pathname}` };
}

describe("crawled meta description", () => {
  it("carries the source page's description, and '' when it has none", async () => {
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      depth: 1,
      maxPages: 5,
      throttleMs: 0,
      fetcher,
    });
    const byTitle = new Map(result.pages.map((p) => [p.title, p]));
    expect(byTitle.get("Home")?.metaDescription).toBe("Crawl budget analytics for large sites.");
    expect(byTitle.get("Plain")?.metaDescription).toBe("");
  });
});
