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
});
