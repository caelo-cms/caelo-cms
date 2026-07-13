// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { extractAltTexts, extractOutboundLinks, extractPageMeta } from "./page-facets.js";

const BASE = "https://example.com/en/";

describe("extractOutboundLinks", () => {
  const html = `<!doctype html><html><head></head><body>
    <header><nav>
      <a href="/en/pricing" rel="">Pricing</a>
      <a href="blog">Blog</a>
      <a href="https://twitter.com/acme" rel="noopener noreferrer">Twitter</a>
    </nav></header>
    <main>
      <a href="/en/deep/thing"><span>Deep</span> thing</a>
      <a href="#section">Skip me</a>
      <a href="mailto:hi@example.com">Mail</a>
    </main>
    <footer><a href="/en/impressum">Impressum</a></footer>
  </body></html>`;

  it("resolves relative hrefs to absolute against the base URL", () => {
    const links = extractOutboundLinks(html, BASE);
    const blog = links.find((l) => l.text === "Blog");
    expect(blog?.href).toBe("https://example.com/en/blog");
  });

  it("tags nav / footer / body location by structural position", () => {
    const links = extractOutboundLinks(html, BASE);
    expect(links.find((l) => l.text === "Pricing")?.location).toBe("nav");
    expect(links.find((l) => l.text === "Impressum")?.location).toBe("footer");
    expect(links.find((l) => l.text === "Deep thing")?.location).toBe("body");
  });

  it("keeps rel, strips nested tags from anchor text, and includes cross-host links", () => {
    const links = extractOutboundLinks(html, BASE);
    const tw = links.find((l) => l.text === "Twitter");
    expect(tw?.href).toBe("https://twitter.com/acme");
    expect(tw?.rel).toBe("noopener noreferrer");
    expect(links.find((l) => l.text === "Deep thing")).toBeDefined();
  });

  it("drops fragment, mailto, and tel links", () => {
    const links = extractOutboundLinks(html, BASE);
    expect(links.some((l) => l.href.includes("#section"))).toBe(false);
    expect(links.some((l) => l.href.startsWith("mailto:"))).toBe(false);
  });
});

describe("extractAltTexts", () => {
  it("inventories img alts (incl. empty decorative) and aria-labels, resolving src", () => {
    const html = `<img src="/logo.png" alt="Acme logo">
      <img src="deco.svg" alt="">
      <img src="/nofx.png">
      <button aria-label="Open menu">≡</button>`;
    const alts = extractAltTexts(html, BASE);
    expect(alts).toContainEqual({
      kind: "img-alt",
      text: "Acme logo",
      src: "https://example.com/logo.png",
    });
    // Empty alt kept as a decorative signal.
    expect(alts.some((a) => a.kind === "img-alt" && a.text === "")).toBe(true);
    // img with no alt attribute is not inventoried.
    expect(alts.some((a) => a.src?.includes("nofx"))).toBe(false);
    expect(alts).toContainEqual({ kind: "aria-label", text: "Open menu" });
  });
});

describe("extractPageMeta", () => {
  it("pulls title, description, lang, canonical, hreflang alternates, and headings", () => {
    const html = `<html lang="en"><head>
      <title>Acme — Pricing</title>
      <meta name="description" content="Simple pricing for teams">
      <link rel="canonical" href="/en/pricing">
      <link rel="alternate" hreflang="de" href="https://example.com/de/preise">
      <link rel="alternate" hreflang="en" href="/en/pricing">
    </head><body>
      <h1>Pricing</h1><h2>Plans</h2><h3>FAQ</h3><h4>ignored</h4>
    </body></html>`;
    const meta = extractPageMeta(html, BASE);
    expect(meta.title).toBe("Acme — Pricing");
    expect(meta.metaDescription).toBe("Simple pricing for teams");
    expect(meta.lang).toBe("en");
    expect(meta.canonical).toBe("https://example.com/en/pricing");
    expect(meta.hreflangAlternates).toContainEqual({
      hreflang: "de",
      href: "https://example.com/de/preise",
    });
    expect(meta.headings).toEqual(["h1: Pricing", "h2: Plans", "h3: FAQ"]);
  });

  it("returns empty fields (never throws) for a bare document", () => {
    const meta = extractPageMeta("<html><body><p>hi</p></body></html>", BASE);
    expect(meta.title).toBe("");
    expect(meta.canonical).toBe("");
    expect(meta.hreflangAlternates).toEqual([]);
    expect(meta.headings).toEqual([]);
  });

  it("still extracts content when the meta tag is padded (order-independent)", () => {
    // The restructured scan reads attributes off the whole <meta> span, so a
    // description tag with attributes before name/content still resolves.
    const html = '<meta charset="utf-8" content="Padded" name="description">';
    expect(extractPageMeta(html, BASE).metaDescription).toBe("Padded");
  });
});

// Guards the js/polynomial-redos fix (issue #278): every facet extractor
// must complete in linear time on adversarial input built from the exact
// repeated tokens CodeQL flagged. A 100k-char scan finishes in tens of ms
// linearly, versus many seconds under the O(n²) backtracking these guard
// against, so a 1s budget cleanly separates the two without runner flakiness.
describe("page-facets ReDoS termination (#278)", () => {
  const BUDGET_MS = 1000;
  const N = 100_000;

  function underBudget(fn: () => void): number {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }

  it("anchorText strips tags linearly on a `<` flood (alert line 158)", () => {
    // "…starting with '<' and with many repetitions of '<'"
    const html = `<a href="/x">${"<".repeat(N)}</a>`;
    expect(underBudget(() => extractOutboundLinks(html, BASE))).toBeLessThan(BUDGET_MS);
  });

  it("outbound-link scan is linear on a repeated open-tag stream", () => {
    expect(underBudget(() => extractOutboundLinks("<a".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
  });

  it("alt/aria scan is linear on repeated <img and generic open tags", () => {
    expect(underBudget(() => extractAltTexts("<img".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractAltTexts("<div".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
    // An unterminated alt attribute must not backtrack.
    const evilAlt = `<img alt="${"a".repeat(N)}`;
    expect(underBudget(() => extractAltTexts(evilAlt, BASE))).toBeLessThan(BUDGET_MS);
  });

  it("title scan is linear on a `<title` flood (alert line 248)", () => {
    // "…starting with '<title' and with many repetitions of '<title'"
    expect(underBudget(() => extractPageMeta("<title".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
  });

  it('meta-description scan is linear on repeated name="description" (alert line 250)', () => {
    // "…with many repetitions of 'name=\"description\"'"
    const evilNoContent = `<meta ${'name="description" '.repeat(N)}`;
    expect(underBudget(() => extractPageMeta(evilNoContent, BASE))).toBeLessThan(BUDGET_MS);
    // Same flood but closed with a real content attr: stays fast AND correct.
    const evilThenContent = `<meta ${'name="description" '.repeat(N)}content="ok">`;
    let meta: ReturnType<typeof extractPageMeta> | undefined;
    expect(
      underBudget(() => {
        meta = extractPageMeta(evilThenContent, BASE);
      }),
    ).toBeLessThan(BUDGET_MS);
    expect(meta?.metaDescription).toBe("ok");
  });

  it("canonical / hreflang / lang / heading scans are linear on repeated tags", () => {
    expect(underBudget(() => extractPageMeta("<link".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractPageMeta("<html".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
    expect(underBudget(() => extractPageMeta("<h1".repeat(N), BASE))).toBeLessThan(BUDGET_MS);
  });
});
