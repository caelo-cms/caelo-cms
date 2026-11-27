// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { StructuredDataPage } from "@caelo-cms/plugin-sdk";
import { TEMPLATE_FIXTURES } from "../../test/fixture-templates.js";
import { durationSeconds, sitemapEntriesAnswer } from "./sitemaps.js";

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

  it("reads a duration in hours, minutes and seconds", () => {
    expect(durationSeconds("PT1H2M3S")).toBe(3723);
    expect(durationSeconds("PT4M")).toBe(240);
    expect(durationSeconds("P1D")).toBeUndefined();
    expect(durationSeconds("PT")).toBeUndefined();
  });
});
