// SPDX-License-Identifier: MPL-2.0

/**
 * #1755 — the headings, images, JSON-LD and Open Graph / Twitter tags in a
 * staged page's audit facts (plugin SDK `PluginAuditPageFacts`), read in
 * the same pass as the rest of the facts: in document order, attributed
 * to their module, capped per page, and a JSON-LD block that is not JSON
 * reported, never thrown.
 */

import { describe, expect, it } from "bun:test";
import { AUDIT_FACT_LIMITS } from "@caelo-cms/plugin-sdk";
import type { StagedPage } from "../check.js";
import { siteHostsOf } from "../links-analysis.js";
import { extractPageFacts } from "../page-facts.js";
import { mediaOfPath, pixelDimension } from "../page-facts-collectors.js";

const HOSTS = siteHostsOf(["http://s.test", "https://example.com"]);
const HERO = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const HASH = "0123456789abcdef";

function facts(html: string) {
  const page: StagedPage = {
    pageId: "00000000-0000-4000-8000-000000000001",
    path: "/team",
    url: "http://s.test/team/",
    html,
  };
  return extractPageFacts(page, HOSTS, "no-sitemap");
}

const NO_PLACE = { moduleId: null, listItem: null, pluginSlug: null };

describe("#1755 headings", () => {
  it("lists every heading in document order with its level, text and module", () => {
    const f = facts(`<html><head><title>Team</title></head><body>
      <section data-caelo-module-id="${HERO}">
        <h1>Unser   <em>Team</em></h1>
        <h2 id="werte"><img src="/x.png" alt="Logo"> Werte</h2>
      </section>
      <ul><li data-caelo-module-id="${CARD}" data-caelo-list-item="local/cards/a"><h4>Anna</h4></li></ul>
      <h3></h3>
      <template><h2>Vorlage</h2></template>
      <noscript><h2>Ohne JS</h2></noscript>
    </body></html>`);
    expect(f.headings).toEqual([
      { level: 1, text: "Unser Team", moduleId: HERO, listItem: null, pluginSlug: null },
      { level: 2, text: "Logo Werte", moduleId: HERO, listItem: null, pluginSlug: null },
      { level: 4, text: "Anna", moduleId: CARD, listItem: "local/cards/a", pluginSlug: null },
      { level: 3, text: "", ...NO_PLACE },
    ]);
    expect(f.truncatedFacts).toEqual([]);
  });

  it("ends a heading where a browser does, and keeps an outer one before one nested in it", () => {
    // A heading tag right inside another closes it, as in a browser.
    expect(
      facts(`<html><body><h1>Eins <h2>Zwei</h2></h1></body></html>`).headings.map((h) => [
        h.level,
        h.text,
      ]),
    ).toEqual([
      [1, "Eins"],
      [2, "Zwei"],
    ]);
    const f = facts(`<html><body><h1>Außen <span><h2>Innen</h2></span> Ende</h1></body></html>`);
    expect(f.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Außen Innen Ende"],
      [2, "Innen"],
    ]);
  });

  it("cuts long heading text and caps the heading count", () => {
    const long = "Wort ".repeat(200);
    const many = Array.from({ length: AUDIT_FACT_LIMITS.headings + 3 }, (_, i) => `<h2>H${i}</h2>`);
    const f = facts(`<html><body><h1>${long}</h1>${many.join("")}</body></html>`);
    expect(f.headings[0]?.text.length).toBe(AUDIT_FACT_LIMITS.textLength);
    expect(f.headings).toHaveLength(AUDIT_FACT_LIMITS.headings);
    expect(f.truncated).toBe(true);
    expect(f.truncatedFacts).toEqual(["headings"]);
  });
});

describe("#1755 images", () => {
  it("reads src, library media, alt, dimensions and the decorative marker", () => {
    const f = facts(`<html><body>
      <figure data-caelo-module-id="${HERO}">
        <img src="/_assets/team-photo.${HASH}.jpg" alt="  Das   Team im Büro " width="1200" height="800px">
      </figure>
      <img src="/_assets/team-photo/webp-800.${HASH}.webp" alt="" width="50%">
      <img src="https://cdn.example.org/logo.svg" role="presentation">
      <div aria-hidden="true"><img src="/_caelo/media/missing-shot"></div>
      <img alt="Ohne Quelle">
      <noscript><img src="/fallback.png" alt="x"></noscript>
    </body></html>`);
    expect(f.images).toEqual([
      {
        src: { href: `/_assets/team-photo.${HASH}.jpg`, path: `/_assets/team-photo.${HASH}.jpg` },
        media: { ref: "team-photo", variant: "orig" },
        alt: "Das Team im Büro",
        width: 1200,
        height: 800,
        decorative: false,
        moduleId: HERO,
        listItem: null,
        pluginSlug: null,
      },
      {
        src: {
          href: `/_assets/team-photo/webp-800.${HASH}.webp`,
          path: `/_assets/team-photo/webp-800.${HASH}.webp`,
        },
        media: { ref: "team-photo", variant: "webp-800" },
        alt: "",
        width: null,
        height: null,
        decorative: true,
        ...NO_PLACE,
      },
      {
        src: { href: "https://cdn.example.org/logo.svg", path: null },
        media: null,
        alt: null,
        width: null,
        height: null,
        decorative: true,
        ...NO_PLACE,
      },
      {
        src: { href: "/_caelo/media/missing-shot", path: "/_caelo/media/missing-shot" },
        media: { ref: "missing-shot", variant: "orig" },
        alt: null,
        width: null,
        height: null,
        decorative: true,
        ...NO_PLACE,
      },
      {
        src: null,
        media: null,
        alt: "Ohne Quelle",
        width: null,
        height: null,
        decorative: false,
        ...NO_PLACE,
      },
    ]);
  });

  it("cuts an inline data: image instead of carrying the file", () => {
    const inline = `data:image/png;base64,${"A".repeat(50_000)}`;
    const f = facts(`<html><body><img src="${inline}" alt="Pixel"></body></html>`);
    expect(f.images[0]?.src).toEqual({
      href: inline.slice(0, AUDIT_FACT_LIMITS.urlLength),
      path: null,
    });
    expect(f.images[0]?.media).toBeNull();
  });

  it("caps the image count", () => {
    const many = Array.from(
      { length: AUDIT_FACT_LIMITS.images + 1 },
      (_, i) => `<img src="/i${i}.png" alt="i">`,
    );
    const f = facts(`<html><body>${many.join("")}</body></html>`);
    expect(f.images).toHaveLength(AUDIT_FACT_LIMITS.images);
    expect(f.truncatedFacts).toEqual(["images"]);
  });
});

describe("#1755 JSON-LD", () => {
  it("parses every block of head and body, and reports a malformed one instead of throwing", () => {
    const f = facts(`<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Caelo &amp; Co"}</script>
      <script type="text/javascript">var x = 1;</script>
    </head><body>
      <div data-caelo-module-id="${HERO}">
        <script type="Application/LD+JSON; charset=utf-8">{"@type": "FAQPage", "mainEntity": [],}</script>
      </div>
      <script type="application/ld+json"></script>
      <template><script type="application/ld+json">{"@type":"Inert"}</script></template>
    </body></html>`);
    expect(f.jsonLd).toHaveLength(3);
    expect(f.jsonLd[0]).toEqual({
      kind: "parsed",
      // Script content is raw text: an entity stays as written.
      data: { "@context": "https://schema.org", "@type": "Organization", name: "Caelo &amp; Co" },
      ...NO_PLACE,
    });
    expect(f.jsonLd[1]?.kind).toBe("invalid");
    expect(f.jsonLd[1]?.moduleId).toBe(HERO);
    expect(f.jsonLd[1]?.kind === "invalid" && f.jsonLd[1].error).toContain("JSON Parse error");
    expect(f.jsonLd[2]?.kind).toBe("invalid");
    expect(f.truncatedFacts).toEqual([]);
  });

  it("omits blocks past the page's JSON-LD budget and the block cap, and says so", () => {
    const big = JSON.stringify({
      "@type": "Thing",
      text: "x".repeat(AUDIT_FACT_LIMITS.jsonLdChars),
    });
    const small = '{"@type":"Thing"}';
    const blocks = [small, big, small, ...Array(AUDIT_FACT_LIMITS.jsonLdBlocks).fill(small)];
    const f = facts(
      `<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join("")}</head></html>`,
    );
    expect(f.jsonLd).toHaveLength(AUDIT_FACT_LIMITS.jsonLdBlocks);
    expect(f.jsonLd[0]?.kind).toBe("parsed");
    expect(f.jsonLd[1]).toEqual({ kind: "omitted", chars: big.length, ...NO_PLACE });
    // A smaller block after the omitted one still fits the budget.
    expect(f.jsonLd[2]?.kind).toBe("parsed");
    expect(f.truncatedFacts).toEqual(["jsonLd"]);
  });
});

describe("#1755 Open Graph and Twitter tags", () => {
  it("lists every og/twitter meta with its attribute, in document order", () => {
    const f = facts(`<html><head>
      <meta property="og:title" content="Team &amp; Werte">
      <meta property="OG:Image" content="https://example.com/_assets/share.${HASH}.jpg">
      <meta name="twitter:card" content="summary_large_image">
      <meta property="article:published_time" content="2026-11-01">
      <meta name="twitter:title" property="og:description" content="Beide">
      <meta property="og:locale" content="de_DE">
      <meta name="description" content="keine Social-Meta">
      <meta property="og:" content="kein Schlüssel">
      <meta property="og:url">
    </head></html>`);
    expect(f.socialMeta).toEqual([
      { key: "og:title", attribute: "property", content: "Team & Werte" },
      {
        key: "og:image",
        attribute: "property",
        content: `https://example.com/_assets/share.${HASH}.jpg`,
      },
      { key: "twitter:card", attribute: "name", content: "summary_large_image" },
      { key: "article:published_time", attribute: "property", content: "2026-11-01" },
      { key: "og:description", attribute: "property", content: "Beide" },
      { key: "twitter:title", attribute: "name", content: "Beide" },
      { key: "og:locale", attribute: "property", content: "de_DE" },
    ]);
    expect(f.ogLocale).toBe("de_DE");
  });

  it("cuts a long content and caps the count, and says so", () => {
    const long = "d".repeat(AUDIT_FACT_LIMITS.socialMetaLength + 10);
    const many = Array.from(
      { length: AUDIT_FACT_LIMITS.socialMeta },
      (_, i) => `<meta property="og:image:alt" content="a${i}">`,
    );
    const f = facts(
      `<html><head><meta property="og:description" content="${long}">${many.join("")}</head></html>`,
    );
    expect(f.socialMeta[0]?.content.length).toBe(AUDIT_FACT_LIMITS.socialMetaLength);
    expect(f.socialMeta).toHaveLength(AUDIT_FACT_LIMITS.socialMeta);
    expect(f.truncatedFacts).toEqual(["socialMeta"]);
  });
});

describe("#1755 helpers", () => {
  it("mediaOfPath reads published and editor media URLs, nothing else", () => {
    expect(mediaOfPath(`/_assets/logo.${HASH}.png`)).toEqual({ ref: "logo", variant: "orig" });
    expect(mediaOfPath(`/_assets/logo/icon-64.${HASH}.png`)).toEqual({
      ref: "logo",
      variant: "icon-64",
    });
    const legacy = "0b0e5a52-6a43-4d55-9d6f-2d1b5c2e7a10";
    expect(mediaOfPath(`/_assets/${legacy}/webp-400.${HASH}.webp`)).toEqual({
      ref: legacy,
      variant: "webp-400",
    });
    expect(mediaOfPath("/_caelo/media/logo/webp-800")).toEqual({
      ref: "logo",
      variant: "webp-800",
    });
    expect(mediaOfPath(`/_assets/fonts/inter/${HASH}.woff2`)).toBeNull();
    expect(mediaOfPath("/_assets/logo.png")).toBeNull();
    expect(mediaOfPath("/images/logo.png")).toBeNull();
    expect(mediaOfPath(null)).toBeNull();
  });

  it("pixelDimension reads an attribute as a browser does", () => {
    expect(pixelDimension("640")).toBe(640);
    expect(pixelDimension(" 640px")).toBe(640);
    expect(pixelDimension("12.5")).toBe(12.5);
    expect(pixelDimension("50%")).toBeNull();
    expect(pixelDimension("auto")).toBeNull();
    expect(pixelDimension(undefined)).toBeNull();
  });
});
