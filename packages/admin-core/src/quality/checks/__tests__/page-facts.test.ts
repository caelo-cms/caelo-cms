// SPDX-License-Identifier: MPL-2.0

/**
 * The page facts plugins check (plugin SDK `PluginAuditPageFacts`): read
 * from the rendered HTML like the core checks read it — real attributes
 * only, URLs resolved like a browser, every text attributed to the
 * module, list entry or plugin output it sits in.
 */

import { describe, expect, it } from "bun:test";
import type { StagedPage } from "../check.js";
import { siteHostsOf } from "../links-analysis.js";
import { extractPageFacts, MAX_FACT_LINKS, parseSitemapAlternates } from "../page-facts.js";

const HOSTS = siteHostsOf(["http://s.test", "https://example.com"]);
const MOD = "11111111-1111-4111-8111-111111111111";

function page(html: string, path = "/de/preise"): StagedPage {
  return {
    pageId: "00000000-0000-4000-8000-000000000001",
    path,
    url: `http://s.test${path}/`,
    html,
  };
}

const HTML = `<!doctype html><html lang="de">
<head>
  <title>Preise | Caelo</title>
  <meta name="description" content="Faire Preise">
  <meta name="robots" content="INDEX, follow">
  <meta property="og:locale" content="de_DE">
  <meta property="og:locale:alternate" content="en_GB">
  <link rel="canonical" href="https://example.com/de/preise">
  <link rel="alternate" hreflang="de" href="https://example.com/de/preise">
  <link rel="alternate" hreflang="en" href="https://example.com/en/pricing">
  <link rel="alternate" hreflang="x-default" href="https://example.com/de/preise">
  <script>var t = "nicht sichtbar";</script>
</head>
<body>
  <footer data-caelo-module-id="${MOD}">
    <ul><li data-caelo-list-item="local/items/a"><a href="/en/" hreflang="en">English</a></li></ul>
    <a href="mailto:hi@example.com">Mail</a>
    <a href="/kontakt" aria-label="Kontakt aufnehmen"><svg></svg></a>
  </footer>
  <form><input type="submit" value="Demo anfragen"><input placeholder="Ihre E-Mail"></form>
  <img src="/_caelo/media/x" alt="Team im Büro">
  <p>1.234,56 €</p>
</body></html>`;

describe("extractPageFacts", () => {
  it("reads language, head signals, links and visible text", () => {
    const f = extractPageFacts(page(HTML), HOSTS, "no-sitemap");
    expect(f.lang).toBe("de");
    expect(f.title).toBe("Preise | Caelo");
    expect(f.metaDescription).toBe("Faire Preise");
    expect(f.robots).toBe("index, follow");
    expect(f.ogLocale).toBe("de_DE");
    expect(f.ogLocaleAlternates).toEqual(["en_GB"]);
    expect(f.canonical).toEqual({ href: "https://example.com/de/preise", path: "/de/preise" });
    expect(f.alternates).toEqual([
      { hreflang: "de", href: "https://example.com/de/preise", path: "/de/preise" },
      { hreflang: "en", href: "https://example.com/en/pricing", path: "/en/pricing" },
      { hreflang: "x-default", href: "https://example.com/de/preise", path: "/de/preise" },
    ]);
    expect(f.sitemapAlternates).toBe("no-sitemap");
    expect(f.links).toEqual([
      {
        href: "/en/",
        path: "/en",
        hreflang: "en",
        text: "English",
        moduleId: MOD,
        listItem: "local/items/a",
        pluginSlug: null,
      },
      {
        href: "mailto:hi@example.com",
        path: null,
        hreflang: null,
        text: "Mail",
        moduleId: MOD,
        listItem: null,
        pluginSlug: null,
      },
      {
        href: "/kontakt",
        path: "/kontakt",
        hreflang: null,
        text: "Kontakt aufnehmen",
        moduleId: MOD,
        listItem: null,
        pluginSlug: null,
      },
    ]);
    const texts = f.texts.map((t) => [t.text, t.source, t.moduleId]);
    expect(texts).toContainEqual(["English", "text", MOD]);
    expect(texts).toContainEqual(["Kontakt aufnehmen", "aria-label", MOD]);
    expect(texts).toContainEqual(["Demo anfragen", "value", null]);
    expect(texts).toContainEqual(["Ihre E-Mail", "placeholder", null]);
    expect(texts).toContainEqual(["Team im Büro", "alt", null]);
    // Scripts and the head are never visible text; a number alone is no text.
    expect(f.texts.some((t) => t.text.includes("nicht sichtbar"))).toBe(false);
    expect(f.texts.some((t) => t.text === "Preise | Caelo")).toBe(false);
    expect(f.truncated).toBe(false);
  });

  it("takes the page's sitemap alternates, null when the sitemap does not list it", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://example.com/de/preise</loc>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/preise" />
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/pricing" />
  </url>
</urlset>`;
    const sitemap = parseSitemapAlternates(xml, HOSTS);
    expect(extractPageFacts(page(HTML), HOSTS, sitemap).sitemapAlternates).toEqual([
      { hreflang: "de", href: "https://example.com/de/preise", path: "/de/preise" },
      { hreflang: "en", href: "https://example.com/en/pricing", path: "/en/pricing" },
    ]);
    expect(extractPageFacts(page(HTML, "/de/team"), HOSTS, sitemap).sitemapAlternates).toBeNull();
    expect(parseSitemapAlternates(null, HOSTS)).toBe("no-sitemap");
  });

  it("cuts long pages and says so", () => {
    const links = Array.from(
      { length: MAX_FACT_LINKS + 5 },
      (_, i) => `<a href="/p${i}">x${i}</a>`,
    );
    const f = extractPageFacts(
      page(`<html><body>${links.join("")}</body></html>`),
      HOSTS,
      "no-sitemap",
    );
    expect(f.links).toHaveLength(MAX_FACT_LINKS);
    expect(f.truncated).toBe(true);
  });
});
