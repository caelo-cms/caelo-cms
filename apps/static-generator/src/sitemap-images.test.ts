// SPDX-License-Identifier: MPL-2.0

/** #1762 — which images of a shipped page the sitemap lists. */

import { describe, expect, it } from "bun:test";
import {
  MAX_SITEMAP_IMAGES_PER_URL,
  sitemapImageLines,
  sitemapImagesOf,
} from "./sitemap-images.js";

const HASH = "0123456789abcdef";

describe("sitemapImagesOf", () => {
  it("takes published library files only, one per asset, in page order", () => {
    const html = [
      `<img alt="a" src="/_assets/hero/webp-1600.${HASH}.webp" srcset="/_assets/hero/webp-800.${HASH}.webp 800w">`,
      `<img src='/_assets/hero.${HASH}.jpg'>`,
      `<IMG SRC="/_assets/9b2f0c1e-0000-4000-8000-000000000001/webp-800.${HASH}.webp">`,
      `<img src="/_caelo/media/unpublished">`,
      `<img src="https://tracker.example/p.gif">`,
      `<img src="/_assets/../etc.${HASH}.jpg">`,
      `<img data-src="/_assets/lazy.${HASH}.jpg">`,
      `<div style="background:url(/_assets/bg.${HASH}.jpg)"></div>`,
    ].join("\n");
    expect(sitemapImagesOf(html, "https://example.com/")).toEqual([
      `https://example.com/_assets/hero/webp-1600.${HASH}.webp`,
      `https://example.com/_assets/9b2f0c1e-0000-4000-8000-000000000001/webp-800.${HASH}.webp`,
    ]);
  });

  it("stops at Google's limit per URL", () => {
    const html = Array.from(
      { length: MAX_SITEMAP_IMAGES_PER_URL + 5 },
      (_, i) => `<img src="/_assets/a${i}.${HASH}.jpg">`,
    ).join("");
    expect(sitemapImagesOf(html, "https://example.com")).toHaveLength(MAX_SITEMAP_IMAGES_PER_URL);
  });

  it("escapes what it writes", () => {
    expect(sitemapImageLines(["https://example.com/_assets/a&b.jpg"])).toEqual([
      "    <image:image>",
      "      <image:loc>https://example.com/_assets/a&amp;b.jpg</image:loc>",
      "    </image:image>",
    ]);
  });
});
