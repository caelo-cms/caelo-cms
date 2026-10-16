// SPDX-License-Identifier: MPL-2.0

/**
 * #802 — the designated 404 page ships as `/404.html` (never at its own
 * path), noindex, without a canonical, and outside the sitemap; a
 * designated page missing from a full build fails it loudly.
 */

import { describe, expect, it } from "bun:test";
import { renderSeoHead } from "@caelo-cms/shared";
import { builtPageOutputPath } from "./generate.js";
import { NOT_FOUND_PAGE_FILE, notFoundPageBuildError } from "./not-found-page.js";
import { isSitemapEntry, notFoundPageSeo } from "./seo-pass.js";

const NOT_FOUND_ID = "00000000-0000-4000-8000-000000000404";
const OTHER_ID = "00000000-0000-4000-8000-000000000001";

describe("builtPageOutputPath", () => {
  it("writes the designated 404 page to 404.html in both URL styles", () => {
    const page = { pageId: NOT_FOUND_ID, currentPath: "/not-found" };
    expect(builtPageOutputPath(page, NOT_FOUND_ID, "directory")).toBe(NOT_FOUND_PAGE_FILE);
    expect(builtPageOutputPath(page, NOT_FOUND_ID, "no-extension")).toBe("404.html");
  });

  it("keeps every other page at its composed path", () => {
    const page = { pageId: OTHER_ID, currentPath: "/pricing" };
    expect(builtPageOutputPath(page, NOT_FOUND_ID, "directory")).toBe("pricing/index.html");
    expect(builtPageOutputPath(page, NOT_FOUND_ID, "no-extension")).toBe("pricing");
    expect(builtPageOutputPath({ pageId: OTHER_ID, currentPath: "/" }, null)).toBe("index.html");
  });

  it("without a designation the would-be 404 page ships at its own path", () => {
    expect(builtPageOutputPath({ pageId: NOT_FOUND_ID, currentPath: "/not-found" }, null)).toBe(
      "not-found/index.html",
    );
  });
});

describe("notFoundPageBuildError", () => {
  const base = { notFoundPageId: NOT_FOUND_ID, env: "production" as const, incremental: false };

  it("passes when the designated page is in the build", () => {
    expect(notFoundPageBuildError({ ...base, builtPageIds: [OTHER_ID, NOT_FOUND_ID] })).toBeNull();
  });

  it("fails a full staging/production build whose designated page is missing, naming the fix", () => {
    for (const env of ["staging", "production"] as const) {
      const msg = notFoundPageBuildError({ ...base, env, builtPageIds: [OTHER_ID] });
      expect(msg).toContain("designated 404 page");
      expect(msg).toContain("set_pages_status_many");
      expect(msg).toContain("set_not_found_page");
    }
  });

  it("does not fire without a designation, on dev, or on incremental builds", () => {
    expect(
      notFoundPageBuildError({ ...base, notFoundPageId: null, builtPageIds: [OTHER_ID] }),
    ).toBeNull();
    expect(notFoundPageBuildError({ ...base, env: "dev", builtPageIds: [] })).toBeNull();
    expect(notFoundPageBuildError({ ...base, incremental: true, builtPageIds: [] })).toBeNull();
  });
});

describe("404 page SEO", () => {
  it("renders noindex and no canonical / og:url / JSON-LD url", () => {
    const head = renderSeoHead({
      title: "Page not found",
      metaDescription: "",
      ogImageUrl: null,
      organization: {},
      ...notFoundPageSeo(),
    });
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain("og:url");
    expect(head).not.toContain('"url"');
  });

  it("keeps the 404 page out of the sitemap, and noindex pages too", () => {
    expect(isSitemapEntry({ pageId: NOT_FOUND_ID, noindex: false }, NOT_FOUND_ID)).toBe(false);
    expect(isSitemapEntry({ pageId: OTHER_ID, noindex: false }, NOT_FOUND_ID)).toBe(true);
    expect(isSitemapEntry({ pageId: OTHER_ID, noindex: true }, NOT_FOUND_ID)).toBe(false);
    expect(isSitemapEntry({ pageId: OTHER_ID, noindex: false }, null)).toBe(true);
  });
});
