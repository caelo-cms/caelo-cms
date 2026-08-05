// SPDX-License-Identifier: MPL-2.0

/**
 * issue #423 — capture-first crawling. The same render session that
 * yields a page's HTML now also produces the #247 visual ground truth
 * (source screenshot + computed-style samples): screenshots stream out
 * via `onPageCapture`, samples ride `CrawledPage.styleSamples`, and a
 * capture failure NEVER blocks the crawl (epic #252 operator ruling,
 * 2026-07-12) — content falls back to the plain render, the page stays
 * screenshot-less, and the post-crawl pass owns retry + loud notes.
 *
 * Hermetic: the browser seam (`opts.screenshotter`) is injected; robots
 * and sitemap fetching are disabled so no network is touched.
 */

import { describe, expect, it } from "bun:test";
import { crawlSite } from "./crawler.js";
import type { ElementStyleSample } from "./design-tokens.js";
import type { RenderedHtml, Screenshot, Screenshotter } from "./screenshot.js";

const SAMPLES: ElementStyleSample[] = [
  { role: "body", styles: { color: "rgb(17, 17, 17)", backgroundColor: "rgb(255, 255, 255)" } },
  { role: "a", styles: { color: "rgb(0, 102, 204)" } },
];

const page = (title: string, links: string[] = []): string =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</body></html>`;

interface MockOptions {
  /** URLs whose `capture` always throws (render works — content survives). */
  readonly captureFails?: readonly string[];
  /** URLs whose capture reports a non-HTML content type. */
  readonly nonHtml?: readonly string[];
}

function mockScreenshotter(routes: Record<string, string>, opts: MockOptions = {}) {
  const captureCalls: string[] = [];
  const renderCalls: string[] = [];
  let disposed = false;
  const html = (url: string): string => {
    const body = routes[new URL(url).pathname];
    if (body === undefined) throw new Error(`no route for ${url}`);
    return body;
  };
  const screenshotter: Screenshotter = {
    async capture(url, o): Promise<Screenshot> {
      captureCalls.push(url);
      if (opts.captureFails?.includes(url)) throw new Error("capture blew up");
      if (opts.nonHtml?.includes(url)) {
        return {
          bytes: new Uint8Array(8).fill(9),
          width: 4,
          height: 2,
          finalUrl: url,
          renderedHtml: "%PDF-viewer-shell",
          contentType: "application/pdf",
        };
      }
      return {
        bytes: new Uint8Array(16).fill(7),
        width: 4,
        height: 4,
        finalUrl: url,
        contentType: "text/html",
        ...(o?.sampleStyles ? { styleSamples: SAMPLES } : {}),
        ...(o?.captureHtml ? { renderedHtml: html(url) } : {}),
      };
    },
    async renderHtml(url, o): Promise<RenderedHtml> {
      renderCalls.push(url);
      return {
        finalUrl: url,
        html: html(url),
        contentType: "text/html",
        ...(o?.sampleStyles ? { styleSamples: SAMPLES } : {}),
      };
    },
    async query() {
      return [];
    },
    async dispose() {
      disposed = true;
    },
  };
  return {
    screenshotter,
    captureCalls,
    renderCalls,
    disposed: () => disposed,
  };
}

const HERMETIC = { respectRobots: false, useSitemap: false, throttleMs: 1 } as const;

describe("capture-first crawl (#423)", () => {
  it("LIST mode: one session per page yields html + styleSamples + a streamed screenshot", async () => {
    const mock = mockScreenshotter({ "/": page("Home"), "/about": page("About") });
    const captured: Array<{ url: string; bytes: number }> = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: ["https://site.example/about"],
      screenshotter: mock.screenshotter,
      onPageCapture: async ({ url, screenshot }) => {
        captured.push({ url, bytes: screenshot.bytes.length });
      },
      ...HERMETIC,
    });

    expect(result.pagesCrawled).toBe(2);
    expect(result.errors).toEqual([]);
    // Content came from the CAPTURE session — renderHtml was never needed.
    expect(mock.captureCalls.length).toBe(2);
    expect(mock.renderCalls.length).toBe(0);
    // Samples ride the crawled page; pixels streamed out per page.
    for (const p of result.pages) expect(p.styleSamples).toEqual(SAMPLES);
    expect(captured.map((c) => c.url).sort()).toEqual([
      "https://site.example/",
      "https://site.example/about",
    ]);
    expect(captured.every((c) => c.bytes === 16)).toBe(true);
    expect(result.pages.map((p) => p.title).sort()).toEqual(["About", "Home"]);
  });

  it("discovery (depth) crawls capture too — BFS-found pages get the same treatment", async () => {
    const mock = mockScreenshotter({
      "/": page("Home", ["/found"]),
      "/found": page("Found"),
    });
    const captured: string[] = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      depth: 1,
      maxPages: 5,
      screenshotter: mock.screenshotter,
      onPageCapture: async ({ url }) => {
        captured.push(url);
      },
      ...HERMETIC,
    });
    expect(result.pagesCrawled).toBe(2);
    expect(captured.sort()).toEqual(["https://site.example/", "https://site.example/found"]);
  });

  it("a capture failure falls back to the render for CONTENT and never blocks the run (epic #252)", async () => {
    const broken = "https://site.example/broken";
    const mock = mockScreenshotter(
      { "/": page("Home"), "/broken": page("Broken") },
      { captureFails: [broken] },
    );
    const captured: string[] = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: [broken],
      screenshotter: mock.screenshotter,
      onPageCapture: async ({ url }) => {
        captured.push(url);
      },
      ...HERMETIC,
    });

    // BOTH pages crawled — the failed capture cost pixels, not content.
    expect(result.pagesCrawled).toBe(2);
    expect(result.pages.map((p) => p.title).sort()).toEqual(["Broken", "Home"]);
    // The broken page fell back to renderHtml and still carries samples
    // (tokens without pixels beat no ground truth at all)…
    expect(mock.renderCalls).toEqual([broken]);
    const brokenPage = result.pages.find((p) => p.url === broken);
    expect(brokenPage?.styleSamples).toEqual(SAMPLES);
    // …but no screenshot streamed for it — the post-crawl pass owns retry.
    expect(captured).toEqual(["https://site.example/"]);
  });

  it("gates non-HTML on the capture path (a PDF's viewer shell is not the resource)", async () => {
    const pdf = "https://site.example/file";
    const mock = mockScreenshotter({ "/": page("Home"), "/file": "unused" }, { nonHtml: [pdf] });
    const captured: string[] = [];
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      urls: [pdf],
      screenshotter: mock.screenshotter,
      onPageCapture: async ({ url }) => {
        captured.push(url);
      },
      ...HERMETIC,
    });
    expect(result.pages.map((p) => p.url)).toEqual(["https://site.example/"]);
    expect(result.errors).toEqual([{ url: pdf, reason: "skipped non-html (application/pdf)" }]);
    // No pixels streamed for a page that never entered the result.
    expect(captured).toEqual(["https://site.example/"]);
  });

  it("a throwing onPageCapture sink is recorded loudly but does not block the crawl", async () => {
    const mock = mockScreenshotter({ "/": page("Home") });
    const result = await crawlSite({
      sourceUrl: "https://site.example/",
      depth: 0,
      screenshotter: mock.screenshotter,
      onPageCapture: async () => {
        throw new Error("bucket offline");
      },
      ...HERMETIC,
    });
    expect(result.pagesCrawled).toBe(1);
    expect(result.pages[0]?.title).toBe("Home");
    expect(result.errors).toEqual([
      { url: "https://site.example/", reason: "screenshot persistence failed: bucket offline" },
    ]);
  });

  it("an injected screenshotter is NOT disposed by the crawl (caller owns it)", async () => {
    const mock = mockScreenshotter({ "/": page("Home") });
    await crawlSite({
      sourceUrl: "https://site.example/",
      screenshotter: mock.screenshotter,
      depth: 0,
      ...HERMETIC,
    });
    expect(mock.disposed()).toBe(false);
  });
});
