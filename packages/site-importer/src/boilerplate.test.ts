// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type BoilerplatePageInput, detectBoilerplate } from "./boilerplate.js";

/** A CTA banner with identical copy — a fixed recurring content block. */
const ctaBox = `
  <section class="cta">
    <h3>Ready to try SearchVIU?</h3>
    <p>Start your free 14-day trial — no credit card required.</p>
    <a class="btn" href="/signup">Start free trial</a>
  </section>`;

/** A newsletter signup, identical everywhere it appears. */
const newsletter = `
  <aside class="newsletter">
    <h4>Get our monthly SEO digest</h4>
    <form><input type="email"><button>Subscribe</button></form>
  </aside>`;

function post(
  id: string,
  title: string,
  body: string,
  breadcrumbTrail: string,
): BoilerplatePageInput {
  return {
    pageId: id,
    url: `https://site.test/blog/${id}`,
    clusterKey: "/blog/*",
    html: `
      <article>
        <nav class="breadcrumbs"><a href="/">Home</a> / <a href="/blog">Blog</a> / <span>${breadcrumbTrail}</span></nav>
        <h1>${title}</h1>
        <p>${body}</p>
        ${ctaBox}
      </article>`,
  };
}

describe("detectBoilerplate", () => {
  it("finds a fixed CTA box repeated across pages and suggests a shared content_instance", () => {
    const pages: BoilerplatePageInput[] = [
      post("p1", "First post", "Body one is quite different from the others here.", "First post"),
      post(
        "p2",
        "Second post",
        "Body two says something else entirely on this page.",
        "Second post",
      ),
      post("p3", "Third post", "Body three has its own unique paragraph of content.", "Third post"),
      post(
        "p4",
        "Fourth post",
        "Body four rounds out the set with more prose text.",
        "Fourth post",
      ),
    ];
    const report = detectBoilerplate(pages, { minPages: 3 });
    expect(report.pagesAnalyzed).toBe(4);

    const cta = report.candidates.find((c) => c.sampleText.includes("ready to try searchviu"));
    expect(cta).toBeDefined();
    expect(cta?.kind).toBe("content");
    expect(cta?.contentVaries).toBe(false);
    expect(cta?.pageCount).toBe(4);
    // Confined to the /blog/* cluster and IS every blog page → template block.
    expect(cta?.suggestedPlacement).toBe("template");
  });

  it("flags a breadcrumb zone (same structure, per-page text) as a template block", () => {
    const pages: BoilerplatePageInput[] = [
      post("p1", "Alpha", "Distinct alpha content paragraph goes right here.", "Alpha"),
      post("p2", "Beta", "Distinct beta content paragraph goes right here now.", "Beta"),
      post("p3", "Gamma", "Distinct gamma content paragraph goes right here too.", "Gamma"),
    ];
    const report = detectBoilerplate(pages, { minPages: 3 });
    const breadcrumb = report.candidates.find((c) => c.contentVaries && c.tag === "nav");
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb?.kind).toBe("structure");
    expect(breadcrumb?.suggestedPlacement).toBe("template");
    expect(breadcrumb?.placementReason).toContain("values fill per page");
  });

  it("suggests a LAYOUT when a fixed block appears site-wide across clusters", () => {
    // Newsletter block on every page of two different clusters → site-wide.
    const mk = (id: string, cluster: string): BoilerplatePageInput => ({
      pageId: id,
      url: `https://site.test/${id}`,
      clusterKey: cluster,
      html: `<main><h1>Page ${id}</h1><p>Unique body copy for the page number ${id} here.</p>${newsletter}</main>`,
    });
    const pages = [
      mk("a", "/blog/*"),
      mk("b", "/blog/*"),
      mk("c", "/product/*"),
      mk("d", "/product/*"),
      mk("e", "/about"),
    ];
    const report = detectBoilerplate(pages, { minPages: 3 });
    const news = report.candidates.find((c) => c.sampleText.includes("monthly seo digest"));
    expect(news).toBeDefined();
    expect(news?.suggestedPlacement).toBe("layout");
    expect(news?.clusterKeys.length).toBeGreaterThan(1);
  });

  it("suggests a content_instance for a scattered block not aligned to a whole page-type", () => {
    // CTA on 3 of the 5 blog pages only → recurring content, not a template rule.
    const withCta = (id: string): BoilerplatePageInput => ({
      pageId: id,
      url: `https://site.test/blog/${id}`,
      clusterKey: "/blog/*",
      html: `<article><h1>Post ${id}</h1><p>Unique body for post ${id} with enough words here.</p>${ctaBox}</article>`,
    });
    const noCta = (id: string): BoilerplatePageInput => ({
      pageId: id,
      url: `https://site.test/blog/${id}`,
      clusterKey: "/blog/*",
      html: `<article><h1>Post ${id}</h1><p>Unique body for post ${id} with enough words here.</p></article>`,
    });
    const pages = [withCta("1"), withCta("2"), withCta("3"), noCta("4"), noCta("5")];
    const report = detectBoilerplate(pages, { minPages: 3 });
    const cta = report.candidates.find((c) => c.sampleText.includes("ready to try searchviu"));
    expect(cta).toBeDefined();
    expect(cta?.pageCount).toBe(3);
    expect(cta?.suggestedPlacement).toBe("content_instance");
  });

  it("does not flag a block that appears on fewer than minPages", () => {
    const pages: BoilerplatePageInput[] = [
      post("p1", "Solo", "This CTA only appears on one page so it is not boilerplate.", "Solo"),
      {
        pageId: "p2",
        url: "https://site.test/plain",
        clusterKey: "/about",
        html: `<main><h1>Plain</h1><p>No shared block here at all, just some prose.</p></main>`,
      },
    ];
    const report = detectBoilerplate(pages, { minPages: 3 });
    expect(report.candidates.find((c) => c.sampleText.includes("ready to try"))).toBeUndefined();
  });

  it("falls back to layout/content_instance when no cluster info is supplied", () => {
    const mk = (id: string): BoilerplatePageInput => ({
      pageId: id,
      url: `https://site.test/${id}`,
      html: `<main><h1>Page ${id}</h1><p>Unique body copy for the page number ${id} here.</p>${newsletter}</main>`,
    });
    // 4 of 4 pages → site-wide even without clusters → layout.
    const report = detectBoilerplate([mk("a"), mk("b"), mk("c"), mk("d")], { minPages: 3 });
    const news = report.candidates.find((c) => c.sampleText.includes("monthly seo digest"));
    expect(news?.suggestedPlacement).toBe("layout");
  });

  it("is deterministic — identical input yields identical output", () => {
    const pages: BoilerplatePageInput[] = [
      post("p1", "One", "First body paragraph text that is reasonably long here.", "One"),
      post("p2", "Two", "Second body paragraph text that is reasonably long here.", "Two"),
      post("p3", "Three", "Third body paragraph text that is reasonably long here.", "Three"),
    ];
    const a = JSON.stringify(detectBoilerplate(pages));
    const b = JSON.stringify(detectBoilerplate(pages));
    expect(a).toBe(b);
  });
});
