// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { newsLanguage, renderNewsSitemap, renderVideoSitemap } from "./sitemap-extras.js";

describe("news and video sitemaps (#1761)", () => {
  it("writes a news sitemap entry, escaped", () => {
    expect(
      renderNewsSitemap([
        {
          loc: "https://news.example/de/2026/wahl/",
          title: "Wahl & Folgen <live>",
          publicationName: "Example News",
          language: "de-DE",
          publicationDate: "2026-11-27T08:00:00.000Z",
        },
      ]),
    ).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
        "  <url>",
        "    <loc>https://news.example/de/2026/wahl/</loc>",
        "    <news:news>",
        "      <news:publication>",
        "        <news:name>Example News</news:name>",
        "        <news:language>de</news:language>",
        "      </news:publication>",
        "      <news:publication_date>2026-11-27T08:00:00.000Z</news:publication_date>",
        "      <news:title>Wahl &amp; Folgen &lt;live&gt;</news:title>",
        "    </news:news>",
        "  </url>",
        "</urlset>",
        "",
      ].join("\n"),
    );
  });

  it("writes a video sitemap entry with its optional parts", () => {
    const xml = renderVideoSitemap([
      {
        loc: "https://blog.example/videos/json-ld/",
        videos: [
          {
            thumbnailLoc: "https://blog.example/_assets/thumb.abc.jpg",
            title: "JSON-LD in 4 minutes",
            description: "How a graph links nodes.",
            playerLoc: "https://www.youtube.com/embed/abc123",
            durationSeconds: 253,
            publicationDate: "2026-11-01T09:00:00.000Z",
          },
        ],
      },
    ]);
    expect(xml).toContain(
      "<video:player_loc>https://www.youtube.com/embed/abc123</video:player_loc>",
    );
    expect(xml).toContain("<video:duration>253</video:duration>");
    expect(xml).not.toContain("content_loc");
  });

  it("names Chinese the way Google reads it", () => {
    expect(newsLanguage("zh-Hans")).toBe("zh-cn");
    expect(newsLanguage("zh-TW")).toBe("zh-tw");
    expect(newsLanguage("pt-BR")).toBe("pt");
  });
});
