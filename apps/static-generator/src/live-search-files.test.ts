// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { FEED_ENTRY_LIMIT } from "@caelo-cms/shared";
import { renderAtomFeed } from "./atom-feed.js";
import { bakeRegion } from "./bake-regions.js";
import { pluginRegionsDigest } from "./content-fingerprint.js";
import {
  parseAtomFeed,
  patchSitemapLastmod,
  publishedTitleAndSummary,
  updateAtomFeed,
} from "./live-search-files.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const entry = (pageId: string, changedAt: string, title = `Page ${pageId.slice(0, 1)}`) => ({
  pageId,
  url: `https://example.com/${pageId.slice(0, 4)}/`,
  title,
  summary: "About it & more",
  changedAt,
  publishedAt: "2026-11-01T00:00:00.000Z",
});
const FEED = renderAtomFeed({
  feedUrl: "https://example.com/feed.xml",
  siteUrl: "https://example.com/",
  title: "example.com",
  language: "de",
  hubUrl: "https://pubsubhubbub.appspot.com/",
  entries: [entry(P1, "2026-11-20T10:00:00.000Z"), entry(P2, "2026-11-19T10:00:00.000Z")],
  emptyUpdated: "2026-11-20T12:00:00.000Z",
});

describe("parseAtomFeed", () => {
  it("reads back exactly what renderAtomFeed wrote", () => {
    const parsed = parseAtomFeed(FEED);
    expect(parsed).toMatchObject({
      feedUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com/",
      title: "example.com",
      language: "de",
      hubUrl: "https://pubsubhubbub.appspot.com/",
    });
    expect(parsed.entries).toEqual([
      entry(P1, "2026-11-20T10:00:00.000Z"),
      entry(P2, "2026-11-19T10:00:00.000Z"),
    ]);
  });

  it("refuses a file that is not this generator's feed", () => {
    expect(() => parseAtomFeed("<feed><title>x</title></feed>")).toThrow(
      "Publish live rebuilds it",
    );
  });
});

describe("updateAtomFeed", () => {
  it("moves a changed page to the top with its new date, every other byte as rendered", () => {
    const next = updateAtomFeed(FEED, [entry(P2, "2026-11-21T08:00:00.000Z")]);
    expect(parseAtomFeed(next).entries.map((e) => [e.pageId, e.changedAt])).toEqual([
      [P2, "2026-11-21T08:00:00.000Z"],
      [P1, "2026-11-20T10:00:00.000Z"],
    ]);
    // A no-op update gives the published bytes back.
    expect(updateAtomFeed(FEED, [])).toBe(FEED);
  });

  it("adds a page that was not among the newest and keeps the limit", () => {
    const many = renderAtomFeed({
      ...parseAtomFeed(FEED),
      entries: Array.from({ length: FEED_ENTRY_LIMIT }, (_, i) =>
        entry(
          `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
          "2026-11-10T00:00:00.000Z",
        ),
      ),
      emptyUpdated: "2026-11-10T00:00:00.000Z",
    });
    const next = parseAtomFeed(updateAtomFeed(many, [entry(P2, "2026-11-21T08:00:00.000Z")]));
    expect(next.entries).toHaveLength(FEED_ENTRY_LIMIT);
    expect(next.entries[0]?.pageId).toBe(P2);
  });
});

describe("patchSitemapLastmod", () => {
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    "  <url>",
    "    <loc>https://example.com/a/?x=1&amp;y=2</loc>",
    "    <lastmod>2026-11-01T00:00:00.000Z</lastmod>",
    "    <changefreq>weekly</changefreq>",
    "  </url>",
    "  <url>",
    "    <loc>https://example.com/b/</loc>",
    "    <lastmod>2026-11-02T00:00:00.000Z</lastmod>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");

  it("replaces only the dates of the named URLs", () => {
    const next = patchSitemapLastmod(
      sitemap,
      new Map([["https://example.com/a/?x=1&y=2", "2026-11-21T08:00:00.000Z"]]),
    );
    expect(next).toBe(sitemap.replace("2026-11-01T00:00:00.000Z", "2026-11-21T08:00:00.000Z"));
    expect(patchSitemapLastmod(sitemap, new Map([["https://example.com/none/", "x"]]))).toBe(
      sitemap,
    );
  });
});

describe("publishedTitleAndSummary", () => {
  it("reads the title and description a page shipped with", () => {
    expect(
      publishedTitleAndSummary(
        '<html><head><title>Hello &amp; you</title><meta name="description" content="What &quot;it&quot; is" /></head><body><title>no</title></body></html>',
      ),
    ).toEqual({ title: "Hello & you", summary: 'What "it" is' });
  });
});

describe("pluginRegionsDigest", () => {
  const region = (text: string, bakedAt: string) =>
    bakeRegion({ slug: "comments", pageId: P1, version: "1.0.0", bakedAt, html: `<p>${text}</p>` });

  it("is null without a plugin region", () => {
    expect(pluginRegionsDigest("<main><p>no plugin</p></main>")).toBeNull();
  });

  it("moves with what a plugin shows, not with a fresh bake of the same data", () => {
    const one = pluginRegionsDigest(
      `<main>${region("first comment", "2026-11-20T10:00:00Z")}</main>`,
    );
    const again = pluginRegionsDigest(
      `<main>${region("first comment", "2026-11-21T10:00:00Z")}</main>`,
    );
    const more = pluginRegionsDigest(
      `<main>${region("first comment second comment", "2026-11-21T10:00:00Z")}</main>`,
    );
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toBe(one);
    expect(more).not.toBe(one);
  });
});
