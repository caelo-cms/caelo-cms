// SPDX-License-Identifier: MPL-2.0

/**
 * issue #193 — crawl-scope estimator. Hermetic via injected text
 * fetchers; the network layer is safe-fetch's suite.
 */

import { describe, expect, it } from "bun:test";
import { estimateCrawlScope, estimateListScope } from "./estimate.js";

const fetcherFor =
  (texts: Record<string, { body: string; contentType?: string }>) => async (url: string) => {
    const path = new URL(url).pathname;
    const hit = texts[path];
    if (!hit) return { ok: false, body: "", contentType: "" };
    return { ok: true, body: hit.body, contentType: hit.contentType ?? "text/xml" };
  };

describe("estimateCrawlScope (#193)", () => {
  it("sitemap basis: exact count + time; cost left unpriced for the tool (#298)", async () => {
    const urls = Array.from(
      { length: 340 },
      (_, i) => `<url><loc>https://site.example/p${i}</loc></url>`,
    ).join("");
    const est = await estimateCrawlScope({
      sourceUrl: "https://site.example/",
      textFetcher: fetcherFor({ "/sitemap.xml": { body: `<urlset>${urls}</urlset>` } }),
    });
    if ("failed" in est && est.failed) throw new Error("unexpected failure");
    const e = est as Exclude<typeof est, { failed: true }>;
    expect(e.basis).toBe("sitemap");
    expect(e.pages).toBe(340);
    expect(e.crawlMinutes).toBeGreaterThanOrEqual(3);
    // issue #298 — pricing moved to the propose tool (calls×context model
    // at ai_pricing rates); the scope estimator stays loudly unpriced.
    expect(e.aiCostUsd).toBeNull();
    expect(e.costNote).toContain("not yet priced");
  });

  it("sample basis: homepage links extrapolated and labelled rough", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/s${i}">x</a>`).join("");
    const est = await estimateCrawlScope({
      sourceUrl: "https://site.example/",
      textFetcher: fetcherFor({
        "/": { body: `<html>${links}</html>`, contentType: "text/html" },
      }),
    });
    if ("failed" in est && est.failed) throw new Error("unexpected failure");
    const e = est as Exclude<typeof est, { failed: true }>;
    expect(e.basis).toBe("sample");
    expect(e.pages).toBe(36); // 12 links × factor 3
  });

  it("no sitemap + unreachable homepage = loud failure, not a guess", async () => {
    const est = await estimateCrawlScope({
      sourceUrl: "https://site.example/",
      textFetcher: fetcherFor({}),
    });
    expect("failed" in est && est.failed).toBe(true);
    if ("failed" in est && est.failed) {
      expect(est.reason).toContain("no sitemap.xml");
    }
  });
});

describe("estimateListScope (#229)", () => {
  it("list basis: page count IS the list length (no network, exact)", () => {
    const e = estimateListScope(7);
    expect(e.basis).toBe("list");
    expect(e.pages).toBe(7);
    expect(e.truncated).toBe(false);
    expect(e.crawlMinutes).toBeGreaterThanOrEqual(1);
    // issue #298 — unpriced until the propose tool applies rates.
    expect(e.aiCostUsd).toBeNull();
  });
});
