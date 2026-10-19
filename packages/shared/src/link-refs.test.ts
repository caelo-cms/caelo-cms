// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-1 unit tests for the internal-reference grammar, parser and
 * resolver (epic #724, rollout A). Markers are matched as literal
 * strings: the editor's missing-content surface and the static
 * generator's render gate read them verbatim.
 */

import { describe, expect, it } from "bun:test";
import {
  collectLinkRefsDeep,
  createSiteLinkIndex,
  findLinkRefs,
  formatLinkRef,
  humaniseLinkRefs,
  type LinkRef,
  linkIssueSeverity,
  linkRefTargetKey,
  pageHrefForStyle,
  parseLinkRef,
  resolveLinkRefsInHtml,
} from "./link-refs.js";
import { renderPlacedModule } from "./nested-module-render.js";
import { composePageWithLayout } from "./preview-compose.js";
import { renderTemplate } from "./template-engine.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const MEDIA = "44444444-4444-4444-8444-444444444444";

function index(env: "preview" | "staging" | "production" = "staging") {
  return createSiteLinkIndex({
    env,
    pageUrlStyle: "directory",
    pages: [
      { id: PAGE, path: "/company/about", status: "published" },
      { id: DRAFT, path: "/pricing", status: "draft" },
    ],
    media: [{ id: MEDIA, slug: "hero-shot" }],
  });
}

describe("grammar — parse / format round trip", () => {
  const cases: [string, LinkRef][] = [
    [`caelo:page/${PAGE}`, { kind: "page", pageId: PAGE, query: null, anchor: null }],
    [`caelo:page/${PAGE}#team`, { kind: "page", pageId: PAGE, query: null, anchor: "team" }],
    [
      `caelo:page/${PAGE}?ref=nav&amp;x=1#team`,
      { kind: "page", pageId: PAGE, query: "ref=nav&amp;x=1", anchor: "team" },
    ],
    [`caelo:media/${MEDIA}`, { kind: "media", mediaId: MEDIA, variant: null }],
    [`caelo:media/${MEDIA}/webp-800`, { kind: "media", mediaId: MEDIA, variant: "webp-800" }],
  ];
  for (const [raw, ref] of cases) {
    it(`parses and re-formats ${raw}`, () => {
      expect(parseLinkRef(raw)).toEqual(ref);
      expect(formatLinkRef(ref)).toBe(raw);
    });
  }

  it("rejects paths, external URLs, uppercase ids and embedded references", () => {
    expect(parseLinkRef("/about")).toBeNull();
    expect(parseLinkRef("https://example.com/about")).toBeNull();
    expect(parseLinkRef("caelo:page/ABCDEF01-1111-4111-8111-111111111111")).toBeNull();
    expect(parseLinkRef(`see caelo:page/${PAGE}`)).toBeNull();
    expect(parseLinkRef("caelo:page/not-a-uuid")).toBeNull();
  });

  it("finds references inside HTML attributes and srcset lists", () => {
    const html = `<a href="caelo:page/${PAGE}#x">A</a><img srcset="caelo:media/${MEDIA}/webp-400 400w, caelo:media/${MEDIA}/webp-800 800w">`;
    expect(findLinkRefs(html).map(linkRefTargetKey)).toEqual([
      `page/${PAGE}`,
      `media/${MEDIA}`,
      `media/${MEDIA}`,
    ]);
  });

  it("collects references from nested JSON values", () => {
    const values = {
      nav: [{ label: "About", href: `caelo:page/${PAGE}` }],
      body: `<p><a href="caelo:page/${DRAFT}">x</a></p>`,
      count: 3,
    };
    expect(collectLinkRefsDeep(values).map(linkRefTargetKey)).toEqual([
      `page/${PAGE}`,
      `page/${DRAFT}`,
    ]);
  });
});

describe("resolution", () => {
  it("renders page URLs in the serving target's style, keeping query and anchor", () => {
    expect(pageHrefForStyle("/", "directory")).toBe("/");
    expect(pageHrefForStyle("/a/b", "directory")).toBe("/a/b/");
    expect(pageHrefForStyle("/a/b/", "no-extension")).toBe("/a/b");
    const r = index().forPage(null);
    expect(r.resolve(parseLinkRef(`caelo:page/${PAGE}?q=1#team`) as LinkRef)).toEqual({
      status: "resolved",
      url: "/company/about/?q=1#team",
    });
  });

  it("resolves media to the editor media URL the media pass rewrites", () => {
    const r = index().forPage(null);
    expect(r.resolve({ kind: "media", mediaId: MEDIA, variant: null })).toEqual({
      status: "resolved",
      url: "/_caelo/media/hero-shot",
    });
    expect(r.resolve({ kind: "media", mediaId: MEDIA, variant: "webp-800" })).toEqual({
      status: "resolved",
      url: "/_caelo/media/hero-shot/webp-800",
    });
  });

  it("reports a draft target as unpublished in deploy envs, resolved in the preview", () => {
    const ref: LinkRef = { kind: "page", pageId: DRAFT, query: null, anchor: null };
    expect(index("staging").forPage(null).resolve(ref)).toEqual({
      status: "unpublished",
      url: "/pricing/",
      pageId: DRAFT,
    });
    expect(index("preview").forPage(null).resolve(ref)).toEqual({
      status: "resolved",
      url: "/pricing/",
    });
  });

  it("records every resolution for the integrity check", () => {
    const r = index().forPage(null);
    resolveLinkRefsInHtml(`<a href="caelo:page/${GONE}">x</a>`, r, []);
    expect(r.observed).toEqual([
      {
        ref: { kind: "page", pageId: GONE, query: null, anchor: null },
        resolution: { status: "missing" },
      },
    ]);
  });

  it("applies the per-environment policy from the #724 decisions", () => {
    expect(linkIssueSeverity("preview", "missing")).toBe("block");
    expect(linkIssueSeverity("staging", "missing")).toBe("block");
    expect(linkIssueSeverity("staging", "unpublished")).toBe("warning");
    expect(linkIssueSeverity("production", "unpublished")).toBe("block");
    expect(linkIssueSeverity("preview", "unpublished")).toBeNull();
    expect(linkIssueSeverity("production", "resolved")).toBeNull();
  });

  it("leaves a missing target raw and marks it", () => {
    const missing: string[] = [];
    const out = resolveLinkRefsInHtml(
      `<a href="caelo:page/${GONE}#a">x</a>`,
      index().forPage(null),
      missing,
    );
    expect(out).toBe(`<a href="caelo:page/${GONE}#a">x</a>`);
    expect(missing).toEqual([`link-target-missing:page/${GONE}`]);
  });

  it("marks every reference when the caller has no resolver", () => {
    const missing: string[] = [];
    resolveLinkRefsInHtml(`caelo:media/${MEDIA}`, undefined, missing);
    expect(missing).toEqual([`link-resolver-unavailable:media/${MEDIA}`]);
  });
});

describe("template engine — references resolve wherever they come from", () => {
  const resolver = () => index().forPage(null);

  it("resolves module HTML attributes, values, defaults and link-list items", () => {
    const r = renderTemplate({
      html: `<a href="caelo:page/${PAGE}">Home</a><a href="{{cta_href}}">{{cta_label}}</a><img src="{{hero}}">{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}<div>{{body}}</div>`,
      fields: [
        { name: "cta_href", kind: "url", default: `caelo:page/${PAGE}#contact` },
        { name: "cta_label", kind: "text" },
        { name: "hero", kind: "image" },
        { name: "nav", kind: "link-list" },
        { name: "body", kind: "richtext" },
      ],
      contentValues: {
        cta_label: "Talk to us",
        hero: `caelo:media/${MEDIA}`,
        nav: [{ label: "Pricing", href: `caelo:page/${DRAFT}` }],
        body: `<p>See <a href="caelo:page/${PAGE}?x=1">about</a></p>`,
      },
      linkResolver: resolver(),
    });
    expect(r.html).toBe(
      '<a href="/company/about/">Home</a><a href="/company/about/#contact">Talk to us</a>' +
        '<img src="/_caelo/media/hero-shot"><a href="/pricing/">Pricing</a>' +
        '<div><p>See <a href="/company/about/?x=1">about</a></p></div>',
    );
    expect(r.missingSlots).toEqual([]);
  });

  it("flags a missing target in missingSlots and keeps the reference visible", () => {
    const r = renderTemplate({
      html: '<a href="{{link}}">x</a>',
      fields: [{ name: "link", kind: "link" }],
      contentValues: { link: `caelo:page/${GONE}` },
      linkResolver: resolver(),
    });
    expect(r.html).toBe(`<a href="caelo:page/${GONE}">x</a>`);
    expect(r.missingSlots).toEqual([`link-target-missing:page/${GONE}`]);
  });

  it("reports a broken reference in a nested module once, with its field trail", () => {
    const CHILD_MOD = "55555555-5555-4555-8555-555555555555";
    const CHILD_CI = "66666666-6666-4666-8666-666666666666";
    const r = renderPlacedModule(
      {
        html: "<section>{{>card}}</section>",
        fields: [{ name: "card", kind: "module" }],
        values: { card: { moduleId: CHILD_MOD, contentInstanceId: CHILD_CI } },
      },
      {
        getModule: (id) =>
          id === CHILD_MOD
            ? {
                moduleId: CHILD_MOD,
                slug: "card",
                html: '<a href="{{href}}">x</a>',
                css: "",
                js: "",
                fields: [{ name: "href", kind: "url" }],
              }
            : null,
        getContentInstance: (id) =>
          id === CHILD_CI
            ? { id, moduleId: CHILD_MOD, values: { href: `caelo:page/${GONE}` }, deletedAt: null }
            : null,
      },
      { linkResolver: resolver() },
    );
    expect(r.failures).toEqual([{ field: "card", reason: `link-target-missing:page/${GONE}` }]);
  });
});

describe("composer — nav-menu sets and pre-rendered modules", () => {
  it("resolves nav-menu item hrefs and attributes a broken one to the nav module", () => {
    const out = composePageWithLayout({
      layoutHtml:
        '<html><head></head><body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body></html>',
      layoutCss: "",
      layoutBlocks: [
        {
          blockName: "header",
          modules: [
            {
              moduleId: "m-nav",
              slug: "nav-menu-main",
              displayName: "Nav",
              html: "",
              css: "",
              js: "",
            },
          ],
        },
      ],
      templateHtml: '<caelo-slot name="content"></caelo-slot>',
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "m-raw",
              slug: "raw",
              displayName: "Raw",
              html: `<a href="caelo:page/${PAGE}">About</a>`,
              css: "",
              js: "",
            },
          ],
        },
      ],
      structuredSets: {
        byKindSlug: {
          "nav-menu/main": [
            { label: "About", href: `caelo:page/${PAGE}` },
            { label: "Gone", href: `caelo:page/${GONE}` },
          ],
        },
      },
      linkResolver: index().forPage(PAGE),
    });
    expect(out.html).toContain('<a href="/company/about/">About</a>');
    expect(out.html).toContain(`href="caelo:page/${GONE}"`);
    expect(out.moduleFailures).toEqual([
      {
        blockName: "header",
        moduleId: "m-nav",
        moduleSlug: "nav-menu-main",
        field: "",
        reason: `link-target-missing:page/${GONE}`,
      },
    ]);
  });
});

// Rollout D — the `link-resolve` composition point's answer: pages in
// variants (locales) grouped by "versions of each other".
const EN_ABOUT = "a1111111-1111-4111-8111-111111111111";
const DE_ABOUT = "a2222222-2222-4222-8222-222222222222";
const EN_PRICING = "b1111111-1111-4111-8111-111111111111";
const DE_PRICING = "b2222222-2222-4222-8222-222222222222";
const EN_SOLO = "c1111111-1111-4111-8111-111111111111";
const EN_HOME = "d1111111-1111-4111-8111-111111111111";
const DE_HOME = "d2222222-2222-4222-8222-222222222222";

function variantIndex(env: "preview" | "staging" = "staging") {
  return createSiteLinkIndex({
    env,
    pageUrlStyle: "directory",
    pages: [
      { id: EN_ABOUT, path: "/about", status: "published" },
      { id: DE_ABOUT, path: "/de/ueber", status: "published" },
      { id: EN_PRICING, path: "/pricing", status: "published" },
      { id: DE_PRICING, path: "/de/preise", status: "draft" },
      { id: EN_SOLO, path: "/solo", status: "published" },
      { id: EN_HOME, path: "/", status: "published" },
      { id: DE_HOME, path: "/de", status: "published" },
    ],
    media: [{ id: MEDIA, slug: "hero-shot" }],
    pageVariants: new Map([
      [EN_ABOUT, { variant: "en", group: "g-about" }],
      [DE_ABOUT, { variant: "de", group: "g-about" }],
      [EN_PRICING, { variant: "en", group: "g-pricing" }],
      [DE_PRICING, { variant: "de", group: "g-pricing" }],
      [EN_SOLO, { variant: "en", group: null }],
      [EN_HOME, { variant: "en", group: "g-home" }],
      [DE_HOME, { variant: "de", group: "g-home" }],
    ]),
  });
}

const pageRef = (pageId: string, anchor: string | null = null): LinkRef => ({
  kind: "page",
  pageId,
  query: null,
  anchor,
});

describe("page variants (link-resolve) — links go to the rendering page's variant", () => {
  it("maps a reference to the same-variant sibling, keeping the anchor", () => {
    const de = variantIndex().forPage(DE_HOME);
    expect(de.resolve(pageRef(EN_ABOUT, "team"))).toEqual({
      status: "resolved",
      url: "/de/ueber/#team",
    });
    // Already in the rendering variant: unchanged.
    expect(de.resolve(pageRef(DE_ABOUT))).toEqual({ status: "resolved", url: "/de/ueber/" });
    // A source-variant page renders its own variant's page.
    const en = variantIndex().forPage(EN_HOME);
    expect(en.resolve(pageRef(DE_ABOUT))).toEqual({ status: "resolved", url: "/about/" });
    expect(en.resolve(pageRef(EN_ABOUT))).toEqual({ status: "resolved", url: "/about/" });
  });

  it("applies the environment policy to the SIBLING (an unpublished German version)", () => {
    expect(variantIndex("staging").forPage(DE_HOME).resolve(pageRef(EN_PRICING))).toEqual({
      status: "unpublished",
      url: "/de/preise/",
      pageId: DE_PRICING,
    });
    expect(variantIndex("preview").forPage(DE_HOME).resolve(pageRef(EN_PRICING))).toEqual({
      status: "resolved",
      url: "/de/preise/",
    });
  });

  it("refuses a target without a sibling in the rendering variant, loudly", () => {
    const missing: string[] = [];
    const out = resolveLinkRefsInHtml(
      `<a href="caelo:page/${EN_SOLO}">Solo</a>`,
      variantIndex().forPage(DE_HOME),
      missing,
    );
    expect(out).toBe(`<a href="caelo:page/${EN_SOLO}">Solo</a>`);
    expect(missing).toEqual([`link-variant-missing:page/${EN_SOLO}:de`]);
    expect(linkIssueSeverity("preview", "no-variant")).toBe("block");
    expect(linkIssueSeverity("staging", "no-variant")).toBe("block");
  });

  it("maps nothing for a page no plugin has an opinion about, or a render outside a page", () => {
    expect(variantIndex().forPage(PAGE).resolve(pageRef(EN_SOLO))).toEqual({
      status: "resolved",
      url: "/solo/",
    });
    expect(variantIndex().forPage(null).resolve(pageRef(DE_ABOUT))).toEqual({
      status: "resolved",
      url: "/de/ueber/",
    });
  });

  it("covers HTML href, rich text, link field and link-list in one render", () => {
    const r = renderTemplate({
      html: `<a href="caelo:page/${EN_HOME}">Home</a><a href="{{cta_href}}">Go</a>{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}<div>{{body}}</div>`,
      fields: [
        { name: "cta_href", kind: "link" },
        { name: "nav", kind: "link-list" },
        { name: "body", kind: "richtext" },
      ],
      contentValues: {
        cta_href: `caelo:page/${EN_PRICING}#plans`,
        nav: [
          { label: "About", href: `caelo:page/${EN_ABOUT}` },
          { label: "Solo", href: `caelo:page/${EN_SOLO}` },
        ],
        body: `<p><a href="caelo:page/${EN_ABOUT}?x=1">about</a></p>`,
      },
      linkResolver: variantIndex("preview").forPage(DE_PRICING),
    });
    expect(r.html).toBe(
      '<a href="/de/">Home</a><a href="/de/preise/#plans">Go</a>' +
        `<a href="/de/ueber/">About</a><a href="caelo:page/${EN_SOLO}">Solo</a>` +
        '<div><p><a href="/de/ueber/?x=1">about</a></p></div>',
    );
    expect(r.missingSlots).toEqual([`link-variant-missing:page/${EN_SOLO}:de`]);
  });

  it("covers nav-menu sets in the composer and attributes a missing sibling to the nav", () => {
    const out = composePageWithLayout({
      layoutHtml:
        '<html><head></head><body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body></html>',
      layoutCss: "",
      layoutBlocks: [
        {
          blockName: "header",
          modules: [
            {
              moduleId: "m-nav",
              slug: "nav-menu-main",
              displayName: "Nav",
              html: "",
              css: "",
              js: "",
            },
          ],
        },
      ],
      templateHtml: '<caelo-slot name="content"></caelo-slot>',
      templateCss: "",
      blocks: [],
      structuredSets: {
        byKindSlug: {
          "nav-menu/main": [
            { label: "About", href: `caelo:page/${EN_ABOUT}` },
            { label: "Solo", href: `caelo:page/${EN_SOLO}` },
          ],
        },
      },
      linkResolver: variantIndex().forPage(DE_ABOUT),
    });
    expect(out.html).toContain('<a href="/de/ueber/">About</a>');
    expect(out.moduleFailures).toEqual([
      {
        blockName: "header",
        moduleId: "m-nav",
        moduleSlug: "nav-menu-main",
        field: "",
        reason: `link-variant-missing:page/${EN_SOLO}:de`,
      },
    ]);
  });
});

describe("humanise — reads show paths, never ids", () => {
  it("maps references back to authorable paths and keeps broken ones raw", () => {
    const lookup = {
      pagePath: (id: string) => (id === PAGE ? "/company/about" : null),
      mediaSlug: (id: string) => (id === MEDIA ? "hero-shot" : null),
    };
    expect(
      humaniseLinkRefs(
        {
          a: `caelo:page/${PAGE}#team`,
          b: [`<img src="caelo:media/${MEDIA}/webp-800">`],
          c: `caelo:page/${GONE}`,
        },
        lookup,
      ),
    ).toEqual({
      a: "/company/about#team",
      b: ['<img src="/_caelo/media/hero-shot/webp-800">'],
      c: `caelo:page/${GONE}`,
    });
  });
});
