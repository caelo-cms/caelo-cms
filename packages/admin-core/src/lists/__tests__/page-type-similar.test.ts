// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — the page type duplicate guard's normaliser: normalised-equal
 * slugs are the same kind of content (refused), a small edit distance is
 * only a hint (`news` / `new`, `faq` / `fab` must never be refused).
 */

import { describe, expect, it } from "bun:test";
import { guardPageTypeSlug, pageTypeSlugKey } from "../page-type-similar.js";

const type = (slug: string, pageCount = 0) => ({ slug, purpose: `${slug} pages`, pageCount });

describe("pageTypeSlugKey", () => {
  it("folds case, separators, plurals and neutral suffix words", () => {
    expect(pageTypeSlugKey("blog")).toBe("blog");
    expect(pageTypeSlugKey("blogs")).toBe("blog");
    expect(pageTypeSlugKey("blog-post")).toBe("blog");
    expect(pageTypeSlugKey("Blog_Posts")).toBe("blog");
    expect(pageTypeSlugKey("news-article")).toBe("news");
    expect(pageTypeSlugKey("landing-page")).toBe("landing");
    expect(pageTypeSlugKey("categories")).toBe("category");
    expect(pageTypeSlugKey("product-pages")).toBe("product");
  });

  it("keeps words whose trailing s is no plural, and lone suffix words", () => {
    expect(pageTypeSlugKey("news")).toBe("news");
    expect(pageTypeSlugKey("status")).toBe("status");
    expect(pageTypeSlugKey("page")).toBe("page");
    expect(pageTypeSlugKey("faq")).toBe("faq");
  });
});

describe("guardPageTypeSlug", () => {
  it("refuses a normalised-equal slug unless distinctFrom names it", () => {
    const blog = type("blog", 12);
    expect(guardPageTypeSlug("blogs", [blog]).duplicates).toEqual([blog]);
    expect(guardPageTypeSlug("blog-post", [blog]).duplicates).toEqual([blog]);
    expect(guardPageTypeSlug("blogs", [blog], ["blog"]).duplicates).toEqual([]);
  });

  it("only hints at near slugs", () => {
    const g1 = guardPageTypeSlug("news", [type("new")]);
    expect(g1.duplicates).toEqual([]);
    expect(g1.near.map((n) => n.slug)).toEqual(["new"]);
    const g2 = guardPageTypeSlug("faq", [type("fab")]);
    expect(g2.duplicates).toEqual([]);
    expect(g2.near.map((n) => n.slug)).toEqual(["fab"]);
    expect(guardPageTypeSlug("product", [type("event")]).near).toEqual([]);
  });

  it("never compares a slug with itself (an update of the same type)", () => {
    expect(guardPageTypeSlug("blog", [type("blog")])).toEqual({ duplicates: [], near: [] });
  });
});
