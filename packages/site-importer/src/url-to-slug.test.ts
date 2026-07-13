// SPDX-License-Identifier: MPL-2.0

/**
 * Run #9 R8 regression — `urlToSlug` must strip the crawl root's path
 * prefix ONLY from URLs that actually live under it. The pre-fix code
 * sliced `sourcePath.length` chars off every pathname, mangling every
 * page outside the prefix (`/tools` → `ols`, `/pricing` → `icing`,
 * `/blog` → `og` — 23 pages in the run #9 crawl).
 */

import { describe, expect, it } from "bun:test";
import { urlToSlug } from "./crawler.js";

describe("urlToSlug", () => {
  describe("crawl rooted at a locale prefix (https://site.example/en/)", () => {
    const source = "https://site.example/en/";

    it("keeps the full path for pages OUTSIDE the prefix", () => {
      expect(urlToSlug("https://site.example/tools", source)).toBe("tools");
      expect(urlToSlug("https://site.example/pricing", source)).toBe("pricing");
      expect(urlToSlug("https://site.example/blog", source)).toBe("blog");
    });

    it("strips the prefix for pages UNDER it", () => {
      expect(urlToSlug("https://site.example/en/blog/x", source)).toBe("blog-x");
    });

    it("maps the site root to 'home'", () => {
      expect(urlToSlug("https://site.example/", source)).toBe("home");
    });

    it("maps the crawl root itself to 'home'", () => {
      expect(urlToSlug("https://site.example/en/", source)).toBe("home");
      expect(urlToSlug("https://site.example/en", source)).toBe("home");
    });

    it("does not treat a shared-prefix SEGMENT as under the root (/enterprise is not /en/*)", () => {
      expect(urlToSlug("https://site.example/enterprise", source)).toBe("enterprise");
    });
  });

  describe("crawl rooted at the origin (https://site.example/)", () => {
    const source = "https://site.example/";

    it("keeps every path verbatim", () => {
      expect(urlToSlug("https://site.example/tools", source)).toBe("tools");
      expect(urlToSlug("https://site.example/en/blog/x", source)).toBe("en-blog-x");
    });

    it("maps the root to 'home'", () => {
      expect(urlToSlug("https://site.example/", source)).toBe("home");
    });
  });

  it("normalises for the cms slug constraint (lowercase, a-z0-9-)", () => {
    expect(urlToSlug("https://site.example/About/Team/", "https://site.example/")).toBe(
      "about-team",
    );
    expect(urlToSlug("https://site.example/a//b/", "https://site.example/")).toBe("a-b");
  });
});
