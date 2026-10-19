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
  findMalformedLinkRefs,
  formatLinkRef,
  humaniseLinkRefs,
  type LinkRef,
  linkIssueSeverity,
  linkRefTargetKey,
  mapLinkRefsDeep,
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

describe("grammar edge cases — boundaries, contexts, malformed references", () => {
  const resolveIn = (html: string, resolver = index().forPage(null)) => {
    const missing: string[] = [];
    return { html: resolveLinkRefsInHtml(html, resolver, missing), missing };
  };

  it("formatLinkRef refuses a reference that would not parse back", () => {
    expect(() =>
      formatLinkRef({ kind: "page", pageId: "About", query: null, anchor: null }),
    ).toThrow(/not a valid internal reference/);
    expect(() =>
      formatLinkRef({ kind: "page", pageId: PAGE, query: "a b", anchor: null }),
    ).toThrow();
    expect(() =>
      formatLinkRef({ kind: "page", pageId: PAGE, query: null, anchor: "x#y" }),
    ).toThrow();
    expect(() => formatLinkRef({ kind: "media", mediaId: MEDIA, variant: "WEBP" })).toThrow();
    expect(formatLinkRef({ kind: "media", mediaId: MEDIA, variant: "webp-800" })).toBe(
      `caelo:media/${MEDIA}/webp-800`,
    );
  });

  it("does not treat `caelo:` inside another scheme or word as a reference", () => {
    for (const text of [`xcaelo:page/${PAGE}`, `my-caelo:page/${PAGE}`, `a.caelo:media/${MEDIA}`]) {
      expect(findLinkRefs(text)).toEqual([]);
      expect(findMalformedLinkRefs(text)).toEqual([]);
      expect(resolveIn(text)).toEqual({ html: text, missing: [] });
    }
  });

  it("leaves prose that mentions the grammar alone, but flags malformed refs in every link position", () => {
    const prose = "<p>Stored as <code>caelo:page/&lt;id&gt;</code> or caelo:media/&lt;id&gt;.</p>";
    expect(resolveIn(prose)).toEqual({ html: prose, missing: [] });
    const positions: [string, string][] = [
      [`<a href='caelo:page/oops'>x</a>`, "caelo:page/oops"],
      ["<a href=caelo:page/oops>x</a>", "caelo:page/oops"],
      [
        `<img srcset="caelo:media/${MEDIA} 1x, caelo:media/${MEDIA}/BAD 2x">`,
        `caelo:media/${MEDIA}/BAD`,
      ],
      [`<img srcset="caelo:media/${MEDIA} 1x,caelo:media/x 2x">`, "caelo:media/x"],
      ["caelo:page/oops", "caelo:page/oops"],
    ];
    for (const [html, raw] of positions) {
      expect(resolveIn(html).missing).toEqual([`link-ref-malformed:${raw}`]);
    }
  });

  it("resolves references in every quoting and text context", () => {
    const cases: [string, string][] = [
      [`<a href="caelo:page/${PAGE}">x</a>`, '<a href="/company/about/">x</a>'],
      [`<a href='caelo:page/${PAGE}#t'>x</a>`, "<a href='/company/about/#t'>x</a>"],
      [`<a href=caelo:page/${PAGE}>x</a>`, "<a href=/company/about/>x</a>"],
      [`<p>See caelo:page/${PAGE}.</p>`, "<p>See /company/about/.</p>"],
      [`(caelo:page/${PAGE})`, "(/company/about/)"],
      [
        `<script type="application/ld+json">{"url":"caelo:page/${PAGE}"}</script>`,
        '<script type="application/ld+json">{"url":"/company/about/"}</script>',
      ],
      [`&quot;caelo:page/${PAGE}&quot;`, "&quot;/company/about/&quot;"],
      [
        `<img srcset="caelo:media/${MEDIA}/webp-400 400w,caelo:media/${MEDIA} 800w">`,
        '<img srcset="/_caelo/media/hero-shot/webp-400 400w,/_caelo/media/hero-shot 800w">',
      ],
    ];
    for (const [input, expected] of cases)
      expect(resolveIn(input)).toEqual({ html: expected, missing: [] });
  });

  it("carries query and anchor verbatim, including characters outside the classes", () => {
    expect(resolveIn(`caelo:page/${PAGE}?x=[1]#a`).html).toBe("/company/about/?x=[1]#a");
    expect(resolveIn(`caelo:page/${PAGE}?`).html).toBe("/company/about/?");
    expect(resolveIn(`caelo:page/${PAGE}#`).html).toBe("/company/about/#");
    const longQuery = "a".repeat(700);
    expect(resolveIn(`caelo:page/${PAGE}?${longQuery}#end`).html).toBe(
      `/company/about/?${longQuery}#end`,
    );
  });

  it("flags text that starts like a reference but breaks the grammar, and leaves it raw", () => {
    const malformed = [
      "caelo:page/not-a-uuid",
      `caelo:page/${PAGE.slice(0, 30)}`,
      "caelo:page/ABCDEF01-1111-4111-8111-111111111111",
      `caelo:page/${PAGE}abc`,
      `caelo:page/${PAGE}/team`,
      `caelo:page/${PAGE}_x`,
      `caelo:media/${MEDIA}/WEBP`,
      `caelo:media/${MEDIA}/webp-800/x`,
      `caelo:media/${MEDIA}/`,
      "caelo:media/",
    ];
    for (const raw of malformed) {
      const html = `<a href="${raw}">x</a>`;
      expect(findLinkRefs(html)).toEqual([]);
      expect(resolveIn(html)).toEqual({ html, missing: [`link-ref-malformed:${raw}`] });
      // Loud without a resolver too: the marker names the real problem.
      const noResolver: string[] = [];
      resolveLinkRefsInHtml(html, undefined, noResolver);
      expect(noResolver).toEqual([`link-ref-malformed:${raw}`]);
    }
  });

  it("bounds the malformed snippet so a marker never carries a whole document", () => {
    const { missing } = resolveIn(`caelo:page/${"x".repeat(5000)}`);
    expect(missing).toHaveLength(1);
    expect((missing[0] as string).length).toBeLessThan(140);
  });

  it("is idempotent: a resolved render holds no reference to resolve again", () => {
    const once = resolveIn(`<a href="caelo:page/${PAGE}#a">x</a><img src="caelo:media/${MEDIA}">`);
    expect(findLinkRefs(once.html)).toEqual([]);
    expect(resolveIn(once.html)).toEqual({ html: once.html, missing: [] });
  });

  it("returns the same object from mapLinkRefsDeep when nothing changed", () => {
    const value = { a: ["/about", { b: 1, c: null }], d: "text" };
    expect(mapLinkRefsDeep(value, () => "/x")).toBe(value);
    const changed = mapLinkRefsDeep({ a: [`caelo:page/${PAGE}`] }, () => "/x");
    expect(changed).toEqual({ a: ["/x"] });
  });

  it("treats an unpublished target as a blocker only in production builds", () => {
    const ref: LinkRef = { kind: "page", pageId: DRAFT, query: null, anchor: null };
    expect(index("production").forPage(null).resolve(ref).status).toBe("unpublished");
    // Not a render failure — the environment policy decides.
    const missing: string[] = [];
    expect(
      resolveLinkRefsInHtml(`caelo:page/${DRAFT}`, index("production").forPage(null), missing),
    ).toBe("/pricing/");
    expect(missing).toEqual([]);
  });

  it("reports a malformed reference in a nested module once", () => {
    const CHILD_MOD = "77777777-7777-4777-8777-777777777777";
    const CHILD_CI = "88888888-8888-4888-8888-888888888888";
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
            ? { id, moduleId: CHILD_MOD, values: { href: "caelo:page/oops" }, deletedAt: null }
            : null,
      },
      { linkResolver: index().forPage(null) },
    );
    expect(r.failures).toEqual([{ field: "card", reason: "link-ref-malformed:caelo:page/oops" }]);
  });
});

describe("scanner stays linear on adversarial input (CodeQL js/polynomial-redos)", () => {
  // Same budget rationale as __tests__/redos-hardening.test.ts: a
  // polynomial regression costs seconds on 100k chars, linear costs ms.
  const BUDGET_MS = 250;
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const inputs = [
    "caelo:page/".repeat(10_000),
    "caelo:media/".repeat(10_000),
    `caelo:media/${MEDIA}/${"a".repeat(100_000)}`,
    `caelo:page/${PAGE}?${"a".repeat(100_000)}`,
    `caelo:page/${PAGE}#${"a".repeat(100_000)}`,
    `${"caelo:page/11111111-1111-4111-8111-".repeat(3_000)}`,
    `${`caelo:page/${PAGE}`.repeat(2_000)}`,
  ];
  for (const [i, input] of inputs.entries()) {
    it(`input ${i} (${input.length} chars) completes under budget`, () => {
      expect(
        time(() => {
          resolveLinkRefsInHtml(input, index().forPage(null), []);
          findLinkRefs(input);
        }),
      ).toBeLessThan(BUDGET_MS);
    });
  }
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
