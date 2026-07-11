// SPDX-License-Identifier: MPL-2.0

/**
 * issue #194 — structural signatures must cluster a realistic mixed
 * site correctly WITHOUT AI help (≥90% AC), keep the homepage a
 * singleton, and stay stable under content-only variation.
 */

import { describe, expect, it } from "bun:test";
import { computePageSignature, pathShape, summariseClusters } from "./page-signature.js";

const SOURCE = "https://site.example/";

const blogPost = (title: string, paras: number): string =>
  `<html><body><header><h1>${title}</h1></header><article>${"<p>text</p>".repeat(paras)}<img src="x.jpg"></article><section><h2>Related</h2><ul><li>a</li><li>b</li></ul></section></body></html>`;

const productPage = (name: string): string =>
  `<html><body><h1>${name}</h1><section><img src="a.jpg"><img src="b.jpg"><table><tr><td>Spec</td></tr></table></section><section><h2>Details</h2><form><input></form></section></body></html>`;

const staticPage = (h: string): string =>
  `<html><body><h1>${h}</h1><section><h2>About</h2><p>x</p></section></body></html>`;

describe("pathShape", () => {
  it("generalises the last segment", () => {
    expect(pathShape("https://s.example/blog/my-post")).toBe("/blog/*");
    expect(pathShape("https://s.example/about")).toBe("/*");
    expect(pathShape("https://s.example/")).toBe("/");
    expect(pathShape("https://s.example/shop/tools/hammer")).toBe("/shop/tools/*");
  });
});

describe("computePageSignature (#194)", () => {
  it("homepage is ALWAYS the singleton 'home' cluster", () => {
    expect(
      computePageSignature({ url: "https://site.example/", sourceUrl: SOURCE, html: "<html/>" }),
    ).toBe("home");
    // Trailing-slash / origin normalisation.
    expect(
      computePageSignature({
        url: "https://site.example",
        sourceUrl: "https://site.example/",
        html: blogPost("x", 3),
      }),
    ).toBe("home");
  });

  it("clusters a mixed 20-page site correctly without AI help", () => {
    const rows: { id: string; clusterKey: string }[] = [];
    // 12 blog posts with varying content length.
    for (let i = 0; i < 12; i++) {
      rows.push({
        id: `blog-${i}`,
        clusterKey: computePageSignature({
          url: `https://site.example/blog/post-${i}`,
          sourceUrl: SOURCE,
          html: blogPost(`Post ${i}`, 3 + (i % 3)),
        }),
      });
    }
    // 5 product pages.
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: `prod-${i}`,
        clusterKey: computePageSignature({
          url: `https://site.example/products/tool-${i}`,
          sourceUrl: SOURCE,
          html: productPage(`Tool ${i}`),
        }),
      });
    }
    // 3 top-level static pages (same simple shape).
    for (const slug of ["about", "imprint", "contact-info"]) {
      rows.push({
        id: `static-${slug}`,
        clusterKey: computePageSignature({
          url: `https://site.example/${slug}`,
          sourceUrl: SOURCE,
          html: staticPage(slug),
        }),
      });
    }
    const clusters = summariseClusters(rows);
    // Exactly three clusters, sized 12/5/3 — 100% on this fixture.
    expect(clusters.map((c) => c.count).sort((a, b) => b - a)).toEqual([12, 5, 3]);
    const blogCluster = clusters.find((c) => c.memberIds.includes("blog-0"));
    expect(blogCluster?.count).toBe(12);
    expect(blogCluster?.memberIds.every((id) => id.startsWith("blog-"))).toBe(true);
  });

  it("different DOM shapes at the same path depth stay apart", () => {
    const a = computePageSignature({
      url: "https://site.example/about",
      sourceUrl: SOURCE,
      html: staticPage("About"),
    });
    const b = computePageSignature({
      url: "https://site.example/pricing",
      sourceUrl: SOURCE,
      html: productPage("Pricing"),
    });
    expect(a).not.toBe(b);
  });

  it("summariseClusters pins nothing above size order except home handling", () => {
    const clusters = summariseClusters([
      { id: "h", clusterKey: "home" },
      { id: "a", clusterKey: "x" },
      { id: "b", clusterKey: "x" },
    ]);
    expect(clusters.find((c) => c.clusterKey === "x")?.count).toBe(2);
    expect(clusters.some((c) => c.clusterKey === "home")).toBe(true);
  });
});
