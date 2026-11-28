// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  SITEMAP_DESCRIPTION_MAX,
  SITEMAP_TITLE_MAX,
  type StructuredDataPage,
} from "@caelo-cms/plugin-sdk";
import { TEMPLATE_FIXTURES } from "../../test/fixture-templates.js";
import { boundedText, durationSeconds, sitemapEntriesAnswer } from "./sitemaps.js";

const NOW = new Date("2026-11-27T12:00:00.000Z");

const news = (id: string, publishedAt: string | null): StructuredDataPage => ({
  pageId: id,
  pageType: "news",
  path: `/news/${id}`,
  isHome: false,
  lang: "de",
  title: `Meldung ${id}`,
  shortTitle: id,
  description: "",
  shareImage: null,
  live: publishedAt !== null,
  publishedAt,
  properties: {},
  terms: [],
  propertyTerms: [],
  listed: [],
});

describe("news and video sitemap entries (#1761)", () => {
  it("lists news articles of the last 48 hours only", () => {
    const pages = [
      news("a", "2026-11-27T08:00:00.000Z"),
      news("b", "2026-11-24T08:00:00.000Z"),
      news("c", null),
    ];
    const answer = sitemapEntriesAnswer(
      {
        args: {
          pages,
          related: [],
          pageTypes: { news: { properties: [] } },
          site: { organization: false, name: "N" },
        },
        mappings: new Map([["news", { pageType: "news", schemaType: "NewsArticle", roles: {} }]]),
      },
      NOW,
    );
    expect(answer.pages).toEqual({ a: { news: { title: "Meldung a" } } });
  });

  it("lists a video page with its thumbnail, player and duration", () => {
    const fixture = TEMPLATE_FIXTURES.find((f) => f.schemaType === "VideoObject");
    if (!fixture) throw new Error("no video fixture");
    const answer = sitemapEntriesAnswer(
      {
        args: {
          pages: [fixture.page],
          related: [],
          pageTypes: { [fixture.page.pageType]: { properties: fixture.properties } },
          site: { organization: false, name: null },
        },
        mappings: new Map([[fixture.page.pageType, fixture.mapping]]),
      },
      NOW,
    );
    expect(answer.pages[fixture.page.pageId]).toEqual({
      videos: [
        {
          title: "JSON-LD in 4 Minuten",
          description: "JSON-LD in 4 Minuten: what this page is about.",
          thumbnail: { media: fixture.page.shareImage as string },
          playerUrl: { url: "https://www.youtube.com/embed/abc123" },
          durationSeconds: 253,
        },
      ],
    });
  });

  it("bounds a long video description and title to the sitemap's limits (Codex on #1797)", () => {
    const fixture = TEMPLATE_FIXTURES.find((f) => f.schemaType === "VideoObject");
    if (!fixture) throw new Error("no video fixture");
    // 2,500 characters of description: valid for the graph, too long for a sitemap.
    const page = {
      ...fixture.page,
      title: "T".repeat(SITEMAP_TITLE_MAX + 10),
      description: "Walkthrough. ".repeat(200),
    };
    const answer = sitemapEntriesAnswer(
      {
        args: {
          pages: [page],
          related: [],
          pageTypes: { [page.pageType]: { properties: fixture.properties } },
          site: { organization: false, name: null },
        },
        mappings: new Map([[page.pageType, fixture.mapping]]),
      },
      NOW,
    );
    const video = answer.pages[page.pageId]?.videos?.[0];
    expect(video?.description.length).toBeLessThanOrEqual(SITEMAP_DESCRIPTION_MAX);
    expect(video?.description.startsWith("Walkthrough. Walkthrough.")).toBe(true);
    expect(video?.description.endsWith("…")).toBe(true);
    expect(video?.title.length).toBeLessThanOrEqual(SITEMAP_TITLE_MAX);
  });

  it("cuts text on a character boundary, never inside a surrogate pair", () => {
    // 9 units of text, then an emoji (2 units) across the cut at 10.
    const cut = boundedText("abcdefghi\u{1F3AC}tail", 11);
    expect(cut).toBe("abcdefghi…");
    expect(cut.length).toBeLessThanOrEqual(11);
    expect(boundedText("\u{1F3AC}\u{1F3AC}x", 4)).toBe("\u{1F3AC}…");
    expect(boundedText("short", 10)).toBe("short");
  });

  it("reads a duration in hours, minutes and seconds", () => {
    expect(durationSeconds("PT1H2M3S")).toBe(3723);
    expect(durationSeconds("PT4M")).toBe(240);
    expect(durationSeconds("P1D")).toBeUndefined();
    expect(durationSeconds("PT")).toBeUndefined();
  });
});
