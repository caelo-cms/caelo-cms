// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ContentInventory,
  checkContentCoverage,
  checkInventoryCoverage,
  extractContentInventory,
  imageBasename,
  normHref,
} from "./content-inventory.js";

describe("extractContentInventory", () => {
  it("extracts headings, paragraphs, list items, images, links, and CTAs", () => {
    const html = `
      <main>
        <h1>About SearchVIU</h1>
        <p>We measure how bots crawl your site.</p>
        <ul><li>Faster indexing</li><li>Cleaner logs</li></ul>
        <img src="https://cdn.example.com/img/hero.png?v=2" alt="hero shot">
        <a href="/pricing">See pricing</a>
        <a class="btn btn-primary" href="/signup">Start free trial</a>
        <button>Contact us</button>
      </main>`;
    const inv = extractContentInventory(html);
    const kinds = inv.items.map((i) => i.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("paragraph");
    expect(kinds).toContain("list_item");
    expect(kinds).toContain("image");
    expect(kinds).toContain("link");
    expect(kinds).toContain("cta");

    const heading = inv.items.find((i) => i.kind === "heading");
    expect(heading?.text).toBe("About SearchVIU");

    // The <a class="btn"> reads as a CTA, the plain <a> stays a link.
    const ctas = inv.items.filter((i) => i.kind === "cta").map((i) => i.text);
    expect(ctas).toContain("Start free trial");
    expect(ctas).toContain("Contact us");
    const links = inv.items.filter((i) => i.kind === "link").map((i) => i.text);
    expect(links).toContain("See pricing");

    // Image basename strips host + query.
    const img = inv.items.find((i) => i.kind === "image");
    expect(img?.src).toBe("hero.png");
  });

  it("records the nearest preceding heading as sourceContext", () => {
    const html = `<h2>Features</h2><p>First feature.</p><h2>Pricing</h2><p>Costs money.</p>`;
    const inv = extractContentInventory(html);
    const first = inv.items.find((i) => i.kind === "paragraph" && i.text === "First feature.");
    const second = inv.items.find((i) => i.kind === "paragraph" && i.text === "Costs money.");
    expect(first?.sourceContext).toBe("Features");
    expect(second?.sourceContext).toBe("Pricing");
  });

  it("collapses whitespace, decodes entities, and dedupes identical items", () => {
    const html = `<p>Tom &amp;   Jerry</p><nav><a href="/a">Home</a><a href="/a">Home</a></nav>`;
    const inv = extractContentInventory(html);
    const para = inv.items.find((i) => i.kind === "paragraph");
    expect(para?.text).toBe("Tom & Jerry");
    // The duplicate nav link collapses to a single inventory item.
    expect(inv.items.filter((i) => i.kind === "link" && i.text === "Home")).toHaveLength(1);
  });

  it("captures anchor text nested inside a paragraph as both a link and prose", () => {
    const html = `<p>Read our <a href="/docs">documentation</a> today.</p>`;
    const inv = extractContentInventory(html);
    expect(inv.items.some((i) => i.kind === "link" && i.text === "documentation")).toBe(true);
    expect(inv.items.some((i) => i.kind === "paragraph" && i.text?.includes("documentation"))).toBe(
      true,
    );
  });
});

describe("normHref / imageBasename", () => {
  it("normalizes hrefs by stripping fragment + trailing slash + case", () => {
    expect(normHref("/Pricing/#top")).toBe("/pricing");
    expect(normHref("HTTPS://Example.com/Path/")).toBe("https://example.com/path");
  });
  it("reduces an image url to its basename", () => {
    expect(imageBasename("https://cdn.example.com/2024/07/Photo.JPG?w=800")).toBe("photo.jpg");
  });
});

describe("checkInventoryCoverage", () => {
  const source: ContentInventory = extractContentInventory(`
    <h1>Welcome</h1>
    <p>We help teams ship faster with fewer regressions.</p>
    <ul><li>Continuous crawl</li><li>Log analysis</li></ul>
    <img src="https://old-host.com/media/logo.svg" alt="logo">
    <a href="/contact">Talk to sales</a>
  `);

  it("reports full coverage when the rebuild keeps every item (reworded markup)", () => {
    // Clean rebuild: semantic markup, same content, image rehosted under a
    // migrated media path (basename preserved), link kept by anchor text.
    const rebuilt = `
      <section class="hero">
        <h1>Welcome</h1>
        <p>We help teams ship faster with fewer regressions.</p>
        <ul class="clean-list">
          <li>Continuous crawl</li>
          <li>Log analysis</li>
        </ul>
        <img src="/media/logo.svg" alt="Company logo">
        <a class="btn" href="/contact">Talk to sales</a>
      </section>`;
    const report = checkInventoryCoverage(source, rebuilt);
    expect(report.counts.missing).toBe(0);
    expect(report.counts.covered).toBe(report.counts.total);
  });

  it("reports missing items LOUDLY when the rebuild drops content", () => {
    // The rebuild silently loses one list item, the image, and the CTA.
    const rebuilt = `
      <section>
        <h1>Welcome</h1>
        <p>We help teams ship faster with fewer regressions.</p>
        <ul><li>Continuous crawl</li></ul>
      </section>`;
    const report = checkInventoryCoverage(source, rebuilt);
    expect(report.counts.missing).toBeGreaterThan(0);
    const missingTexts = report.missing.map((m) => m.text ?? m.src ?? m.href);
    expect(missingTexts).toContain("Log analysis");
    expect(report.counts.missingByKind.list_item).toBe(1);
    expect(report.counts.missingByKind.image).toBe(1);
    expect(report.missing.some((m) => m.kind === "cta" || m.kind === "link")).toBe(true);
  });

  it("matches an image via its migrated media equivalent", () => {
    const src: ContentInventory = extractContentInventory(
      `<img src="https://old-host.com/wp-content/uploads/hero-2024.png">`,
    );
    // Rebuild references a renamed migrated asset; the equivalence map bridges it.
    const rebuilt = `<img src="/media/abc123.png" alt="hero">`;
    const report = checkInventoryCoverage(src, rebuilt, {
      migratedImageEquivalents: {
        "https://old-host.com/wp-content/uploads/hero-2024.png": "/media/abc123.png",
      },
    });
    expect(report.counts.missing).toBe(0);
  });

  it("covers a reflowed paragraph via substring match but flags a genuinely dropped one", () => {
    const src: ContentInventory = extractContentInventory(
      `<p>Our platform continuously crawls your site and surfaces indexing regressions early.</p>
       <p>Pricing starts at forty nine euros per month with no contract.</p>`,
    );
    // First paragraph reflowed across two <p>; second paragraph dropped.
    const rebuilt = `<p>Our platform continuously crawls your site</p>
                     <p>and surfaces indexing regressions early.</p>`;
    const report = checkInventoryCoverage(src, rebuilt);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]?.text).toContain("forty nine euros");
  });

  it("requires exact match for short strings (no spurious substring hit)", () => {
    const src: ContentInventory = extractContentInventory(`<a href="/x">Buy</a>`);
    // "buy" would substring-match "buying" — but it is below the length
    // floor, so only an exact text/href match counts. Neither is present.
    const rebuilt = `<p>Consider buying our subscription bundle</p>`;
    const report = checkInventoryCoverage(src, rebuilt);
    expect(report.counts.missing).toBe(1);
  });
});

describe("checkContentCoverage (convenience wrapper)", () => {
  it("extracts then checks in one call", () => {
    const report = checkContentCoverage(`<h1>Hi</h1><p>Body text here.</p>`, `<h1>Hi</h1>`);
    expect(report.counts.total).toBe(2);
    expect(report.counts.missing).toBe(1);
    expect(report.missing[0]?.kind).toBe("paragraph");
  });
});

describe("robustness against malformed and adversarial input", () => {
  it("stays linear on a '<'-flood (no polynomial ReDoS in the tag stripper)", () => {
    // 100k '<' with no '>' is the CodeQL js/polynomial-redos trigger for
    // `<[^>]*>`; the tempered `[^<>]*` fix keeps this well under a second.
    const flood = "<".repeat(100_000);
    const start = performance.now();
    const report = checkContentCoverage("<p>hello world content</p>", flood);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // The source paragraph is genuinely absent from a tag-only rebuild.
    expect(report.counts.missing).toBe(1);
  });

  it("does not corrupt attribution on mismatched / stray / unclosed tags", () => {
    // Crawled HTML is routinely malformed: a </p> closing across an open
    // <b>, a stray </b>, an unclosed <li>, and orphan </div></section>.
    const malformed = `<section><h2>Heading here</h2><p>Alpha <b>bold text</p> stray</b>
      <ul><li>List item one <li>List item two</ul></div></section>`;
    const inv = extractContentInventory(malformed);
    // The paragraph is attributed once, the heading became context, and
    // both list items are captured — nothing throws or duplicates wildly.
    const para = inv.items.find((i) => i.kind === "paragraph");
    expect(para?.text).toContain("Alpha bold text");
    expect(para?.sourceContext).toBe("Heading here");
    const listItems = inv.items.filter((i) => i.kind === "list_item").map((i) => i.text);
    expect(listItems).toContain("List item one");
    expect(listItems).toContain("List item two");
    // A stray close with no matching open must not manufacture items.
    expect(extractContentInventory("</div></p></span>stray text").items).toHaveLength(0);
  });

  it("is stable on deeply nested markup (no stack blow-up)", () => {
    const deep = `${"<div>".repeat(4000)}<p>Deep buried paragraph text</p>${"</div>".repeat(4000)}`;
    const start = performance.now();
    const inv = extractContentInventory(deep);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(inv.items.some((i) => i.kind === "paragraph")).toBe(true);
  });
});
