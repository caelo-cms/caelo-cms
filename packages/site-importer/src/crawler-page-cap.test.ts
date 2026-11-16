// SPDX-License-Identifier: MPL-2.0

/**
 * #1590 — the page cap holds at every concurrency. The crawl counts a URL
 * toward `maxPages` when a worker takes it, not when its page is done, so
 * parallel workers cannot all claim while the count is still below the cap
 * (each page past it cost a capture-job render). A URL whose page is
 * dropped gives its slot back, so the crawl still fills the cap.
 *
 * Hermetic: a fake fetcher whose pages answer after different delays, so
 * the workers finish out of step as they do against a real site.
 */

import { describe, expect, it } from "bun:test";
import { type CrawlCheckpoint, type CrawlProgress, crawlSite } from "./crawler.js";

const ORIGIN = "https://site.example";

const page = (title: string, links: readonly string[] = []): string =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

/**
 * A home page linking `count` pages, each linking two more of them. `broken`
 * pages answer 404. Every fetch is counted and answers after a delay that
 * differs per page (0–7 ms).
 */
function site(count: number, broken: (i: number) => boolean = () => false) {
  const fetched: string[] = [];
  const paths = Array.from({ length: count }, (_, i) => `/p${i}`);
  const fetcher = async (url: string) => {
    fetched.push(url);
    const path = new URL(url).pathname;
    const i = path === "/" ? -1 : Number(path.slice(2));
    await new Promise((r) => setTimeout(r, ((i + 1) * 5) % 8));
    if (path === "/") return { ok: true, html: page("Home", paths), contentType: "text/html" };
    if (Number.isNaN(i) || i >= count || broken(i)) {
      return { ok: false, html: "", contentType: "text/html" };
    }
    const next = [`/p${(i + 1) % count}`, `/p${(i + 7) % count}`];
    return { ok: true, html: page(`Page ${i}`, next), contentType: "text/html" };
  };
  return { fetched, fetcher };
}

describe("the page cap (#1590)", () => {
  for (const concurrency of [1, 2, 4, 8]) {
    for (const maxPages of [1, 2, 5, 8, 13]) {
      it(`renders and extracts exactly ${maxPages} page(s) at concurrency ${concurrency}`, async () => {
        const s = site(40);
        const streamed: string[] = [];
        const result = await crawlSite({
          sourceUrl: `${ORIGIN}/`,
          fetcher: s.fetcher,
          throttleMs: 0,
          maxPages,
          concurrency,
          batchSize: 3,
          onBatch: async (pages) => {
            streamed.push(...pages.map((p) => p.url));
          },
        });
        // Every page of this site is good: one render per page, none past the cap.
        expect(s.fetched).toHaveLength(maxPages);
        expect(result.pagesCrawled).toBe(maxPages);
        expect(streamed).toHaveLength(maxPages);
        expect(new Set(streamed).size).toBe(maxPages);
      });
    }
  }

  it("a dropped page gives its slot back: the crawl fills the cap with good pages and keeps no more", async () => {
    // Every third page is missing.
    const s = site(40, (i) => i % 3 === 0);
    const result = await crawlSite({
      sourceUrl: `${ORIGIN}/`,
      fetcher: s.fetcher,
      throttleMs: 0,
      maxPages: 10,
      concurrency: 4,
    });
    expect(result.pagesCrawled).toBe(10);
    expect(result.pages).toHaveLength(10);
    expect(result.errors.length).toBeGreaterThan(0);
    // The renders that made a page are exactly the cap; the rest were the dropped ones.
    expect(s.fetched.length - result.errors.length).toBe(10);
  });

  it("a resumed crawl counts the pages its checkpoint holds toward the cap", async () => {
    const first = site(40);
    let mid: CrawlCheckpoint | null = null;
    await crawlSite({
      sourceUrl: `${ORIGIN}/`,
      fetcher: first.fetcher,
      throttleMs: 0,
      maxPages: 9,
      concurrency: 4,
      batchSize: 4,
      onBatch: async () => {},
      onCheckpoint: async (cp) => {
        if (mid === null && cp.pagesCrawled > 0) mid = structuredClone(cp);
      },
    });
    const cp = mid as CrawlCheckpoint | null;
    if (!cp) throw new Error("no checkpoint");
    const resumed = site(40);
    const result = await crawlSite({
      sourceUrl: `${ORIGIN}/`,
      fetcher: resumed.fetcher,
      throttleMs: 0,
      maxPages: 9,
      concurrency: 4,
      resumeFrom: cp,
    });
    expect(result.pagesCrawled).toBe(9);
    expect(resumed.fetched).toHaveLength(9 - cp.pagesCrawled);
  });

  it("each batch says how many URLs the crawl has taken so far", async () => {
    const s = site(40, (i) => i % 5 === 0);
    const progress: Array<CrawlProgress & { written: number }> = [];
    let written = 0;
    const result = await crawlSite({
      sourceUrl: `${ORIGIN}/`,
      fetcher: s.fetcher,
      throttleMs: 0,
      maxPages: 20,
      concurrency: 4,
      batchSize: 5,
      onBatch: async (pages, p) => {
        written += pages.length;
        progress.push({ ...p, written });
      },
    });
    expect(progress.length).toBeGreaterThan(1);
    for (const [i, p] of progress.entries()) {
      // At least every URL whose page it wrote, and never fewer than before.
      expect(p.seenCount).toBeGreaterThanOrEqual(p.written);
      if (i > 0) expect(p.seenCount).toBeGreaterThanOrEqual(progress[i - 1]?.seenCount ?? 0);
      expect(p.seenCount).toBeLessThanOrEqual(result.seenCount);
    }
    expect(progress.at(-1)?.written).toBe(20);
  });
});
