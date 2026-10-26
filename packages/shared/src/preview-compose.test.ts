// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { INTERACTIONS } from "./interactions.js";
import { fixtureData, fixtureLinkIndex, ITEM, LIST } from "./lists/list-fixtures.test.js";
import { createListRenderContext } from "./lists/resolve.js";
import {
  ComposeError,
  composePagePreview,
  composePageWithLayout,
  fontsHeadFragment,
  tagModuleId,
} from "./preview-compose.js";

const blankModule = {
  moduleId: "00000000-0000-0000-0000-000000000000",
  slug: "blank",
  displayName: "Blank",
  html: "",
  css: "",
  js: "",
};

/** List context over the fixture site, rendered outside any page. */
const LISTS = createListRenderContext(fixtureData()).forPage(null);
const uid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

describe("composePagePreview", () => {
  it("inlines module HTML into named slots and stamps CSS/JS into head/body", () => {
    const out = composePagePreview({
      templateHtml: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">x</caelo-slot></body></html>`,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...blankModule,
              html: "<p>HELLO</p>",
              css: "p { color: red; }",
              js: "console.log('hi');",
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(
      `<caelo-slot name="content"><p data-caelo-module-id="00000000-0000-0000-0000-000000000000">HELLO</p></caelo-slot>`,
    );
    expect(out.html).toContain(`<style data-source="modules">`);
    expect(out.html).toContain(`p { color: red; }`);
    expect(out.html).toContain(`<script defer data-source="modules">`);
    expect(out.html).toContain(`console.log('hi');`);
    // CSS appears before </head>; JS before </body>.
    expect(out.html.indexOf(`<style data-source="modules">`)).toBeLessThan(
      out.html.indexOf("</head>"),
    );
    expect(out.html.indexOf(`<script defer data-source="modules">`)).toBeLessThan(
      out.html.indexOf("</body>"),
    );
  });

  it("orders modules within a block by array order", () => {
    const out = composePagePreview({
      templateHtml: `<body><caelo-slot name="x">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [
        {
          blockName: "x",
          modules: [
            { ...blankModule, html: "<p>A</p>" },
            { ...blankModule, html: "<p>B</p>" },
          ],
        },
      ],
    });
    // Both modules use the same blank moduleId so the data-attr collides;
    // ordering is what matters here. Just assert both are present in
    // sequence with the expected separator.
    expect(out.html).toMatch(
      /<p data-caelo-module-id="[^"]+">A<\/p>\n<p data-caelo-module-id="[^"]+">B<\/p>/,
    );
  });

  it("emits template CSS before module CSS so module rules win on tie specificity", () => {
    const out = composePagePreview({
      templateHtml: `<head></head><body></body>`,
      templateCss: "body { color: blue; }",
      blocks: [
        {
          blockName: "x",
          modules: [{ ...blankModule, css: "body { color: red; }" }],
        },
      ],
    });
    const cssBlock = out.html.match(/<style data-source="modules">[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(cssBlock.indexOf("color: blue")).toBeLessThan(cssBlock.indexOf("color: red"));
  });

  it("omits the style tag entirely when no module/template CSS exists", () => {
    const out = composePagePreview({
      templateHtml: `<head></head><body><caelo-slot name="x">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [{ blockName: "x", modules: [{ ...blankModule, html: "<p>x</p>" }] }],
    });
    expect(out.html).not.toContain(`<style data-source="modules">`);
    expect(out.html).not.toContain(`<script defer data-source="modules">`);
  });

  it("records missing slot names when the template has unfilled slots", () => {
    const out = composePagePreview({
      templateHtml: `<body><caelo-slot name="missing">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [],
    });
    expect(out.missingSlots).toEqual(["missing"]);
  });

  it("applies the theme's --font-body to body via the technical baseline (issue #410)", () => {
    // Regression: --font-body was declared by the theme renderer but no
    // rule consumed it, so fresh sites rendered the UA serif. The base
    // block must apply it (with a declared cascade default for
    // themeless installs).
    const out = composePagePreview({
      templateHtml: `<head></head><body><caelo-slot name="x">_</caelo-slot></body>`,
      templateCss: "",
      blocks: [{ blockName: "x", modules: [{ ...blankModule, html: "<p>x</p>" }] }],
    });
    const base = out.html.indexOf('<style data-source="base">');
    expect(base).toBeGreaterThan(-1);
    const baseBlock = out.html.slice(base, out.html.indexOf("</style>", base));
    expect(baseBlock).toContain("body{font-family:var(--font-body,system-ui,sans-serif)}");
  });
});

describe("tagModuleId (P6.7 live-edit overlay support)", () => {
  it("adds data-caelo-module-id to the first opening tag", () => {
    expect(tagModuleId("<p>hello</p>", "abc-123")).toBe(
      `<p data-caelo-module-id="abc-123">hello</p>`,
    );
  });

  it("is idempotent — re-running on tagged HTML is a no-op", () => {
    const once = tagModuleId("<p>x</p>", "id-1");
    expect(tagModuleId(once, "id-1")).toBe(once);
  });

  it("only tags the FIRST opening tag — siblings stay untouched", () => {
    const out = tagModuleId("<p>a</p><p>b</p>", "id-1");
    expect(out).toBe(`<p data-caelo-module-id="id-1">a</p><p>b</p>`);
  });

  it("tolerates leading whitespace + comments before the first tag", () => {
    const out = tagModuleId("  <!-- hi -->\n<div>x</div>", "id-9");
    expect(out).toContain(`<div data-caelo-module-id="id-9">x</div>`);
  });

  it("returns unchanged when there is no opening tag (pure text)", () => {
    expect(tagModuleId("plain text", "id-1")).toBe("plain text");
  });

  it("preserves existing attributes on the first tag", () => {
    expect(tagModuleId(`<h1 class="hero" id="x">A</h1>`, "id-7")).toBe(
      `<h1 class="hero" id="x" data-caelo-module-id="id-7">A</h1>`,
    );
  });
});

describe("composePagePreview substitutes {{name}} placeholders with field defaults", () => {
  // PR #61 follow-up: before this, modules with `{{name}}` placeholders
  // and a declared `fields[]` shipped raw to the browser via the
  // static-generator path (visitors saw literal `{{spantext}}` /
  // `{{ctahref}}` text). The substitution lives in compose so both the
  // preview-iframe path and the static-gen path agree on the default
  // floor. Per-placement overrides (content_instances.values) still
  // happen in preview-render, not here.
  const slot = `<body><caelo-slot name="content">_</caelo-slot></body>`;
  it("fills declared {{name}} placeholders with each field's default", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-x",
              slug: "hero",
              displayName: "Hero",
              html: '<h1>{{heading}}</h1><a href="{{ctahref}}">{{ctalabel}}</a>',
              css: "",
              js: "",
              fields: [
                { name: "heading", default: "Welcome to Caelo" },
                { name: "ctahref", default: "/get-started" },
                { name: "ctalabel", default: "Get started" },
              ],
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(">Welcome to Caelo</h1>");
    expect(out.html).toContain('<a href="/get-started">Get started</a>');
    // No raw `{{name}}` residue in the body.
    expect(out.html).not.toMatch(/\{\{[a-z]/i);
  });
  it("contentValues override field defaults (per-placement wins)", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-z",
              slug: "hero",
              displayName: "Hero",
              html: "<h1>{{heading}}</h1>",
              css: "",
              js: "",
              fields: [{ name: "heading", default: "Default headline" }],
              contentValues: { heading: "Per-placement headline" },
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(">Per-placement headline</h1>");
    expect(out.html).not.toContain("Default headline");
  });
  it("contentValues without a matching field still substitute (values are authoritative)", () => {
    // AI-authored explicit fields without defaults rely on
    // contentValues being the source of truth — the bug e2e-livedit's
    // second Stage hit before this commit (issue #70).
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-w",
              slug: "brand",
              displayName: "Brand",
              html: '<a href="{{brand_href}}">{{brand_name}}</a>',
              css: "",
              js: "",
              fields: [{ name: "brand_href" }, { name: "brand_name" }],
              contentValues: { brand_href: "/", brand_name: "Caelo" },
            },
          ],
        },
      ],
    });
    expect(out.html).toContain('<a href="/" data-caelo-module-id="mod-w">Caelo</a>');
    expect(out.html).not.toMatch(/\{\{brand/);
  });
  it("leaves unknown {{name}} as raw placeholder (no-fallbacks per CLAUDE.md §2)", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-y",
              slug: "broken",
              displayName: "Broken",
              html: "<p>{{declared}} and {{undeclared}}</p>",
              css: "",
              js: "",
              fields: [{ name: "declared", default: "OK" }],
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(">OK and {{undeclared}}</p>");
  });
});

describe("composePagePreview list-iteration via shared template engine (#71)", () => {
  // PR #71 / Plan B — the compose path now routes through the shared
  // template engine and gains list / module-list section support
  // (`list` since epic #1107). The fixtures below are the AC verbatim shapes;
  // failures here imply the static-generator is leaking raw mustache
  // markers to visitors again (the bug #71 closes).
  const slot = `<body><caelo-slot name="content">_</caelo-slot></body>`;

  it("AC #1 — a links list iterates per entry inside composed page", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      lists: LISTS,
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-nav",
              slug: "header",
              displayName: "Header",
              html: '<nav>{{#nav_items}}<a href="{{link}}">{{label}}</a>{{/nav_items}}</nav>',
              css: "",
              js: "",
              fields: [{ name: "nav_items", kind: "list", listType: "links" }],
              contentValues: {
                nav_items: [
                  { id: uid(1), node: "link", values: { label: "Docs", link: { href: "/docs" } } },
                  { id: uid(2), node: "link", values: { label: "Blog", link: { href: "/blog" } } },
                ],
              },
            },
          ],
        },
      ],
    });
    // Outermost element is tagged with data-caelo-module-id; assert
    // the section iterated and that no raw markers leaked into the
    // composed HTML.
    expect(out.html).toContain(
      `<a href="/docs" data-caelo-list-item="local/nav_items/${uid(1)}">Docs</a>`,
    );
    expect(out.html).toContain(
      `<a href="/blog" data-caelo-list-item="local/nav_items/${uid(2)}">Blog</a>`,
    );
    expect(out.html).not.toMatch(/\{\{[#/]/);
    expect(out.html).not.toMatch(/\{\{label/);
    expect(out.html).not.toMatch(/\{\{href/);
    expect(out.html).toContain('data-caelo-module-id="mod-nav"');
  });

  it("AC #2 — a texts list iterates per entry inside composed page", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      lists: LISTS,
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-tags",
              slug: "tags",
              displayName: "Tags",
              html: "<ul>{{#tags}}<li>{{text}}</li>{{/tags}}</ul>",
              css: "",
              js: "",
              fields: [{ name: "tags", kind: "list", listType: "texts" }],
              contentValues: {
                tags: ["a", "b", "c"].map((text, i) => ({
                  id: uid(i + 1),
                  node: "text",
                  values: { text },
                })),
              },
            },
          ],
        },
      ],
    });
    expect(out.html.replace(/ data-caelo-list-item="[^"]*"/g, "")).toContain(
      "<li>a</li><li>b</li><li>c</li>",
    );
    expect(out.html).not.toMatch(/\{\{[#/]/);
    expect(out.html).toContain('data-caelo-module-id="mod-tags"');
  });

  it("AC #3 — unknown {{#unknown}}…{{/unknown}} stays as raw markers in composed output", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-broken",
              slug: "broken",
              displayName: "Broken",
              html: "<p>{{#unknown}}x{{/unknown}}</p>",
              css: "",
              js: "",
              fields: [],
            },
          ],
        },
      ],
    });
    // Raw markers preserved (no silent swallow) so the operator sees
    // the broken template in DevTools, per CLAUDE.md §2.
    expect(out.html).toContain("{{#unknown}}x{{/unknown}}");
  });

  it("AC #4 (compose-path posture) — module-list emits loud HTML comment, never raw markers", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              moduleId: "mod-cards",
              slug: "cards",
              displayName: "Cards",
              html: "<ul>{{#cards}}<li>x</li>{{/cards}}</ul>",
              css: "",
              js: "",
              fields: [{ name: "cards", kind: "module-list" }],
              contentValues: {
                cards: [{ moduleId: "child-mod", contentInstanceId: "child-ci" }],
              },
            },
          ],
        },
      ],
    });
    expect(out.html).toContain(
      "<!-- caelo:module-list cards needs recursive renderer (compose path) -->",
    );
    expect(out.html).not.toMatch(/\{\{[#/]/);
  });
});

describe("composePagePreview tags every module's outermost element", () => {
  const slot = `<body><caelo-slot name="content">_</caelo-slot></body>`;
  it("threads the moduleId through the composed output", () => {
    const out = composePagePreview({
      templateHtml: slot,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            { moduleId: "mod-a", slug: "a", displayName: "A", html: "<p>1</p>", css: "", js: "" },
            { moduleId: "mod-b", slug: "b", displayName: "B", html: "<p>2</p>", css: "", js: "" },
          ],
        },
      ],
    });
    expect(out.html).toContain(`<p data-caelo-module-id="mod-a">1</p>`);
    expect(out.html).toContain(`<p data-caelo-module-id="mod-b">2</p>`);
  });
});

describe("composePageWithLayout", () => {
  const layoutHtml = `<!doctype html><html><head></head><body><header><caelo-slot name="header">_</caelo-slot></header><main><caelo-slot name="content">_</caelo-slot></main></body></html>`;
  const templateHtml = `<body><caelo-slot name="content">_</caelo-slot></body>`;

  // #1085 — an empty header block and an empty content block showed the
  // authored "_" placeholders on the composed page visitors get.
  it("renders empty blocks empty, never the authored slot placeholder", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    const body = out.html.slice(out.html.indexOf("<body>"));
    expect(body).toContain(`<caelo-slot name="header"></caelo-slot>`);
    expect(body).toContain(`<caelo-slot name="content"></caelo-slot>`);
    expect(body).not.toContain("_");
    expect(out.missingSlots).toContain("header");
  });

  it("aggregates CSS in layout → template → modules order", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "/* TPL */",
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...blankModule,
              moduleId: "11111111-1111-1111-1111-111111111111",
              html: "<p>x</p>",
              css: "/* MOD */",
            },
          ],
        },
      ],
      layoutHtml,
      layoutCss: "/* LAYOUT */",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    const css = out.html.slice(
      out.html.indexOf(`<style data-source="modules">`),
      out.html.indexOf("</style>", out.html.indexOf(`<style data-source="modules">`)),
    );
    const layoutIdx = css.indexOf("/* LAYOUT */");
    const tplIdx = css.indexOf("/* TPL */");
    const modIdx = css.indexOf("/* MOD */");
    expect(layoutIdx).toBeGreaterThanOrEqual(0);
    expect(tplIdx).toBeGreaterThan(layoutIdx);
    expect(modIdx).toBeGreaterThan(tplIdx);
  });

  it("injects fonts (preloads + @font-face) before the theme style (issue #150)", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      fonts: {
        css: "@font-face{font-family:\"Poppins\";src:url(/_assets/fonts/poppins/aa.woff2) format('woff2');}",
        preloads: ["/_assets/fonts/poppins/aa.woff2"],
      },
    });
    expect(out.html).toContain('<style data-source="fonts">');
    // Font preloads MUST carry crossorigin even same-origin (fetch spec
    // font-destination CORS rule) or the browser double-downloads.
    expect(out.html).toContain(
      '<link rel="preload" as="font" type="font/woff2" crossorigin href="/_assets/fonts/poppins/aa.woff2">',
    );
    const headEnd = out.html.indexOf("</head>");
    expect(out.html.indexOf('<style data-source="fonts">')).toBeLessThan(headEnd);
  });

  it("omits the fonts fragment entirely for system-stack-only themes (issue #150)", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      fonts: { css: "", preloads: [] },
    });
    expect(out.html).not.toContain('data-source="fonts"');
    expect(out.html).not.toContain('rel="preload"');
  });

  it("renders a responsive nav with once-per-page functional assets (issue #160)", () => {
    // The module owns the markup (epic #1107 — no built-in menu renderer);
    // the interaction kit owns the behaviour.
    const navModule = {
      ...blankModule,
      moduleId: "33333333-3333-4333-8333-333333333303",
      slug: "header-nav",
      html:
        '<nav class="caelo-nav-menu" data-caelo-ui="mobile-nav" data-nav-open="false">' +
        '<button type="button" class="caelo-nav-toggle" aria-expanded="false" aria-label="Menu"></button>' +
        '<ul>{{#menu}}<li><a href="{{link}}">{{label}}</a></li>{{/menu}}</ul></nav>',
      fields: [
        {
          name: "menu",
          kind: "list" as const,
          listType: "menu",
          bind: "shared" as const,
          list: `caelo:list/${LIST.header}`,
        },
      ],
    };
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [{ blockName: "content", modules: [navModule, navModule] }],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      lists: LISTS,
      linkResolver: fixtureLinkIndex().forPage(null),
    });
    expect(out.html).toContain(
      `<li data-caelo-list-item="${LIST.header}/${ITEM.about}"><a href="/about/">About</a></li>`,
    );
    expect(out.html).toContain('class="caelo-nav-toggle"');
    expect(out.html).toContain('aria-expanded="false"');
    expect(out.html).toContain('data-nav-open="false"');
    // Functional assets exactly once, even with two nav placements.
    expect(out.html.split("caelo-nav-toggle{display:none").length - 1).toBe(1);
    expect(out.html.split(INTERACTIONS["mobile-nav"].js).length - 1).toBe(1);
    expect(out.html).toContain('data-caelo-ui="mobile-nav"');
    // Zero aesthetics in the functional css: no colors beyond currentColor.
    expect(out.html).not.toMatch(/caelo-nav-toggle\{[^}]*#[0-9a-f]{3}/i);
  });

  it("ships each vetted interaction once per page, whoever asks for it (issue #160)", () => {
    const tabsModule = {
      ...blankModule,
      moduleId: "33333333-3333-4333-8333-333333333304",
      slug: "pricing-tabs",
      html: '<div class="pricing" data-caelo-ui="tabs"><div role="tablist"></div></div>',
      css: ".pricing{display:grid}",
    };
    const faqModule = {
      ...blankModule,
      moduleId: "33333333-3333-4333-8333-333333333305",
      slug: "faq",
      html: '<div class="faq" data-caelo-ui="accordion"><details><summary>Q</summary>A</details></div>',
    };
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [{ blockName: "content", modules: [tabsModule, faqModule, tabsModule] }],
      // The layout's own chrome may ask too.
      layoutHtml: layoutHtml.replace("<body>", "<body><div data-caelo-ui='tabs'></div>"),
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    expect(out.html.split(INTERACTIONS.tabs.js).length - 1).toBe(1);
    expect(out.html.split(INTERACTIONS.tabs.css).length - 1).toBe(1);
    expect(out.html.split(INTERACTIONS.accordion.js).length - 1).toBe(1);
    // Registry order, independent of which module asked first.
    expect(out.html.indexOf(INTERACTIONS.accordion.js)).toBeLessThan(
      out.html.indexOf(INTERACTIONS.tabs.js),
    );
    // Unused ones stay out.
    expect(out.html).not.toContain(INTERACTIONS.carousel.js);
    expect(out.html).not.toContain(INTERACTIONS["mobile-nav"].js);
    // Functional rules follow module CSS so a module display rule cannot unhide a panel.
    expect(out.html.indexOf(".pricing{display:grid}")).toBeLessThan(
      out.html.indexOf(INTERACTIONS.tabs.css),
    );
  });

  it("ships the interaction a withheld module needs (issue #160)", () => {
    const gated = {
      ...blankModule,
      moduleId: "33333333-3333-4333-8333-333333333306",
      slug: "gallery",
      html: '<section class="gallery" data-caelo-ui="carousel"></section>',
    };
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [{ blockName: "content", modules: [gated] }],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      deferredModules: {
        [gated.moduleId]: {
          pluginSlug: "consent-manager",
          reason: "marketing",
          placeholderModuleSlug: "consent-placeholder",
          placeholderHtml: "<p>consent</p>",
          placeholderCss: "",
        },
      },
    });
    // The snippet binds by delegation, so it works once the plugin clones
    // the module out of its <template> after consent.
    expect(out.html).toContain(INTERACTIONS.carousel.js);
  });

  it("does not ship anything for a data-caelo-ui value outside the kit (issue #160)", () => {
    const out = composePagePreview({
      templateHtml: `<!doctype html><html><head></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [{ ...blankModule, html: '<div data-caelo-ui="lightbox"></div>' }],
        },
      ],
    });
    expect(out.html).not.toContain('data-source="modules"');
  });

  it("injects the invisible technical baseline between theme and modules (issue #151)", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "/* TPL */",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    const base = out.html.indexOf('<style data-source="base">');
    const modules = out.html.indexOf('<style data-source="modules">');
    expect(base).toBeGreaterThan(-1);
    expect(out.html).toContain("box-sizing:border-box");
    expect(base).toBeLessThan(modules); // module CSS overrides the floor
    // Zero design opinion: no colors, no font sizes, no type scale.
    const baseBlock = out.html.slice(base, out.html.indexOf("</style>", base));
    expect(baseBlock).not.toMatch(/#[0-9a-f]{3}|font-size|color:|rem\b/i);
  });

  it("applies the theme's --font-body to body via the technical baseline (issue #410)", () => {
    // Same regression as the composePagePreview variant: both compose
    // paths must ship a consumer for --font-body or the theme's chosen
    // stack never reaches an element.
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    const base = out.html.indexOf('<style data-source="base">');
    expect(base).toBeGreaterThan(-1);
    const baseBlock = out.html.slice(base, out.html.indexOf("</style>", base));
    expect(baseBlock).toContain("body{font-family:var(--font-body,system-ui,sans-serif)}");
  });

  it("emits a twice-placed module's CSS/JS exactly once (issue #158)", () => {
    const shared = {
      ...blankModule,
      moduleId: "22222222-2222-4222-8222-222222222202",
      html: "<p>x</p>",
      css: "/* SHARED-CSS */",
      js: "/* SHARED-JS */",
    };
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [
        { blockName: "content", modules: [shared, shared] },
        { blockName: "header", modules: [shared] },
      ],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    expect(out.html.split("/* SHARED-CSS */").length - 1).toBe(1);
    expect(out.html.split("/* SHARED-JS */").length - 1).toBe(1);
  });

  it("throws ComposeError when the layout lacks a content slot", () => {
    expect(() =>
      composePageWithLayout({
        templateHtml,
        templateCss: "",
        blocks: [],
        layoutHtml: `<!doctype html><html><body><header>chrome</header></body></html>`,
        layoutCss: "",
        layoutBlocks: [],
        layoutSlug: "broken",
      }),
    ).toThrow(ComposeError);
  });

  it("peels a body-wrapping <caelo-slot name='content'> with single-quote attrs", () => {
    // Single-quote attribute would have failed the previous regex peel
    // and produced a nested <caelo-slot> in the output. With the
    // parser-based peel, the wrapping slot is removed and the inner
    // <p>BODY</p> lands directly in the layout's content slot.
    const out = composePageWithLayout({
      templateHtml: `<body><caelo-slot name='content'>_</caelo-slot></body>`,
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [{ ...blankModule, html: "<p>BODY</p>" }],
        },
      ],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    expect(out.html).toContain("<p");
    expect(out.html).toContain(">BODY</p>");
    // Exactly one caelo-slot[name=content] in output (the layout's own).
    const matches = out.html.match(/caelo-slot[^>]*name=["']content["']/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// A complete imported TTF must not be advertised as WOFF2 in preload hints.
it("preloads pinned TTF/OTF/WOFF files with their actual format", () => {
  const html = fontsHeadFragment({
    css: "",
    preloads: [
      "/_assets/fonts/pinned/a.ttf",
      "/_assets/fonts/pinned/b.otf",
      "/_assets/fonts/pinned/c.woff",
    ],
  });
  expect(html).toContain('type="font/ttf"');
  expect(html).toContain('type="font/otf"');
  expect(html).toContain('type="font/woff"');
});

// The theme's favicon is document metadata: binding it via
// `set_theme_asset({slot:"favicon"})` must put a `<link rel="icon">` into
// <head> on every page, without any module carrying the tag. Before this,
// nothing was emitted and browsers fell back to a 404ing /favicon.ico.
describe("theme favicon in <head>", () => {
  const layoutHtml = `<!doctype html><html><head><title>t</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`;
  const templateHtml = `<body><caelo-slot name="content">_</caelo-slot></body>`;
  const themeWith = (favicon: { url: string; mime: string } | null) => ({
    tokens: {},
    assets: {
      logo: null,
      logoDark: null,
      favicon:
        favicon === null ? null : { mediaId: "44444444-4444-4444-8444-444444444444", ...favicon },
      socialShare: null,
    },
  });
  const headOf = (html: string): string => html.slice(0, html.indexOf("</head>"));
  const bodyOf = (html: string): string => html.slice(html.indexOf("</head>"));

  it("composePageWithLayout emits <link rel=icon> with the bound media URL + mime", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      theme: themeWith({ url: "/_caelo/media/viu-one-favicon", mime: "image/svg+xml" }),
    });
    const tag = '<link rel="icon" href="/_caelo/media/viu-one-favicon" type="image/svg+xml">';
    expect(headOf(out.html)).toContain(tag);
    expect(bodyOf(out.html)).not.toContain('rel="icon"');
    // Exactly once per page.
    expect(out.html.split('rel="icon"').length - 1).toBe(1);
  });

  it("composePagePreview emits the same tag", () => {
    const out = composePagePreview({
      templateHtml: `<html><head></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      templateCss: "",
      blocks: [],
      theme: themeWith({ url: "/_caelo/media/fav", mime: "image/png" }),
    });
    expect(headOf(out.html)).toContain(
      '<link rel="icon" href="/_caelo/media/fav" type="image/png">',
    );
  });

  it("emits no icon link when the theme has no favicon bound, or no theme is threaded", () => {
    const base = {
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    };
    expect(composePageWithLayout({ ...base, theme: themeWith(null) }).html).not.toContain(
      'rel="icon"',
    );
    expect(composePageWithLayout(base).html).not.toContain('rel="icon"');
  });

  it("attribute-escapes the URL and mime", () => {
    const out = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
      theme: themeWith({ url: '/x"><script>', mime: "image/png" }),
    });
    expect(out.html).toContain('href="/x&quot;&gt;&lt;script&gt;"');
    expect(out.html).not.toContain('/x"><script>');
  });

  it("base64-encodes the page-wide module script bundle when JS contains </script or <!--", () => {
    const mod = {
      ...blankModule,
      html: "<p>x</p>",
      js: 'const tpl = "</script><img src=x onerror=alert(1)>";',
    };
    const preview = composePagePreview({
      templateHtml: `<html><head></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      templateCss: "",
      blocks: [{ blockName: "content", modules: [mod] }],
    });
    expect(preview.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(preview.html).toContain('src="data:text/javascript;base64,');

    const withLayout = composePageWithLayout({
      templateHtml,
      templateCss: "",
      blocks: [{ blockName: "content", modules: [mod] }],
      layoutHtml,
      layoutCss: "",
      layoutBlocks: [],
      layoutSlug: "test",
    });
    expect(withLayout.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(withLayout.html).toContain('src="data:text/javascript;base64,');
  });
});
