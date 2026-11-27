// SPDX-License-Identifier: MPL-2.0

/**
 * #1732 review, round 3 — a module's plugin values are checked as if it
 * stood in plain HTML content. A layout or template slot that stands
 * elsewhere, and a part of the page that ends outside content (a module
 * left raw text, SVG or a `<select>` open), make that untrue: the plugin
 * values are refused there. Core values render as before either way.
 */

import { describe, expect, it } from "bun:test";
import { fixtureData, INSTANCE, ITEM, LIST, MODULE, PAGE } from "./lists/list-fixtures.test.js";
import { pluginLocalList, pluginValue } from "./lists/plugin-values.js";
import { createListRenderContext } from "./lists/resolve.js";
import type { NestedRenderResolver } from "./nested-module-render.js";
import {
  frameReading,
  OPEN_MARKUP_RULE,
  SLOT_PLACEMENT_RULE,
  templateEndsInContent,
} from "./page-reading.js";
import { composePagePreview, composePageWithLayout } from "./preview-compose.js";
import { renderTemplate } from "./template-engine.js";

const ESCAPE = '<p title="</noscript><img src=x onerror=alert(1)>">Bitte JavaScript aktivieren</p>';
const owned = (value: string, type = "richtext") =>
  pluginValue({ plugin: "evil", point: "content-variants", address: "m/body", type }, value);
const refused = (rule: string) => `plugin-value-refused:evil.content-variants.m/body:${rule}`;

const notice = (
  body: unknown,
  moduleId = "m-notice",
  html = '<div class="notice">{{body}}</div>',
) => ({
  moduleId,
  slug: moduleId,
  displayName: moduleId,
  html,
  css: "",
  js: "",
  fields: [{ name: "body", kind: "richtext" as const }],
  contentValues: { body },
});

function page(
  layoutHtml: string,
  layoutBlocks: { blockName: string; modules: ReturnType<typeof notice>[] }[],
  // A richtext's own `<p>` in a `<div>`: inside the module's `<p>` it would
  // close that one (#1748, `value-breaks-markup`).
  content = notice("<p>Seite</p>", "m-page", "<div>{{body}}</div>"),
) {
  return composePageWithLayout({
    layoutHtml,
    layoutCss: "",
    layoutBlocks,
    templateHtml: '<caelo-slot name="content"></caelo-slot>',
    templateCss: "",
    blocks: [{ blockName: "content", modules: [content] }],
  });
}

const reasons = (out: { moduleFailures: readonly { reason: string }[] }) =>
  out.moduleFailures.map((f) => f.reason);

describe("slots and the page's open parts (#1732 review, round 3)", () => {
  it("2: a slot outside plain content refuses the plugin values of the module it holds", () => {
    for (const layout of [
      '<main><caelo-slot name="content"></caelo-slot></main><noscript><caelo-slot name="fallback"></caelo-slot></noscript>',
      '<main><caelo-slot name="content"></caelo-slot></main><select name="lang"><caelo-slot name="fallback"></caelo-slot></select>',
      '<main><caelo-slot name="content"></caelo-slot></main><svg><caelo-slot name="fallback"></caelo-slot></svg>',
    ]) {
      const out = page(layout, [{ blockName: "fallback", modules: [notice(owned(ESCAPE))] }]);
      expect(reasons(out)).toContain(refused(SLOT_PLACEMENT_RULE));
      expect(out.html).not.toContain("onerror=alert(1)>");
    }
    expect(
      frameReading('<noscript><caelo-slot name="a"></caelo-slot></noscript>').slotsOutside,
    ).toEqual(new Set(["a"]));
  });

  it("2: a slot in plain content keeps them", () => {
    const out = page(
      '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>',
      [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }],
    );
    expect(reasons(out)).toEqual([]);
    expect(out.html).toContain("<p>Fuß</p>");
  });

  it("4: a module that ends outside content refuses every plugin value on the page", () => {
    for (const open of ["<noscript>", "<svg><g>", "<select><option>a", "<!-- note", "<textarea>"]) {
      const out = page(
        '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>',
        [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }],
        { ...notice("x", "m-open", open), fields: [] },
      );
      expect(reasons(out)).toContain(refused(OPEN_MARKUP_RULE));
    }
  });

  it("4: a module without fields is read too; one its caller rendered is the caller's to place", () => {
    const layout =
      '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>';
    const foot = [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }];
    const { fields: _f, contentValues: _v, ...bare } = notice("x", "m-open", "<noscript>");
    expect(reasons(page(layout, foot, bare as ReturnType<typeof notice>))).toContain(
      refused(OPEN_MARKUP_RULE),
    );
    // The editor preview renders its page modules itself and passes the
    // verdict it worked out from their templates as `refusePluginValues`;
    // the composer never reads (or keeps) that per-page output.
    const rendered = { ...bare, rendered: true } as ReturnType<typeof notice>;
    expect(reasons(page(layout, foot, rendered))).toEqual([]);
  });

  it("4: so does a nested module that ends outside content", () => {
    const resolver: NestedRenderResolver = {
      getModule: (id) =>
        id === "m-child"
          ? { moduleId: "m-child", slug: "child", html: "<noscript>", css: "", js: "", fields: [] }
          : null,
      getContentInstance: (id) =>
        id === "ci-child" ? { id, moduleId: "m-child", values: {}, deletedAt: null } : null,
    };
    const out = composePagePreview({
      templateHtml: '<caelo-slot name="content"></caelo-slot>',
      templateCss: "",
      nestedModules: resolver,
      blocks: [
        {
          blockName: "content",
          modules: [
            {
              ...notice(owned("<p>x</p>")),
              html: "{{>child}}<div>{{body}}</div>",
              fields: [
                { name: "child", kind: "module" },
                { name: "body", kind: "richtext" },
              ],
              contentValues: {
                child: { moduleId: "m-child", contentInstanceId: "ci-child" },
                body: owned("<p>x</p>"),
              },
            },
          ],
        },
      ],
    });
    expect(out.moduleFailures.map((f) => f.reason)).toContain(refused(OPEN_MARKUP_RULE));
  });

  it("renders a page without plugin values exactly as before", () => {
    const out = page(
      '<main><caelo-slot name="content"></caelo-slot></main><noscript><caelo-slot name="fallback"></caelo-slot></noscript>',
      [{ blockName: "fallback", modules: [notice("<p>core</p>")] }],
      { ...notice("x", "m-open", "<noscript>"), fields: [] },
    );
    expect(reasons(out)).toEqual([]);
    expect(out.html).toContain("<p>core</p>");
  });
});

/**
 * #1732 review, round 4 — how a module ends is read from where the reading
 * stands at its end, held against every way a render can differ from that
 * reading; the refusal of the module's own later values stays as it was.
 */
describe("where a module ends (#1732 review, round 4)", () => {
  // Shapes real modules use: each ends in plain content.
  const inContent: Record<string, string> = {
    unquotedAlt: `<img src="{{img}}" alt={{alt}} loading="lazy">`,
    unquotedClass: `<div class={{variant}}>{{x}}</div>`,
    commentInComment: `<div><!-- {{! note }} --><p>{{x}}</p></div>`,
    twoUnquoted: `<img alt={{a}} class={{b}} src="x.png">`,
    faq: `<section class="faq"><h2>{{heading}}</h2>{{#items}}<details><summary>{{question}}</summary><div>{{answer}}</div></details>{{/items}}</section>`,
    pricing: `<table class="pricing"><thead><tr><th>Plan</th><th>Preis</th></tr></thead><tbody>{{#plans}}<tr><td>{{name}}</td><td>{{price}}</td></tr>{{/plans}}</tbody></table>`,
    svgIcon: `<a class="cta" href="{{cta.href}}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg> {{label}}</a>`,
    svgThenText: `<span><svg viewBox="0 0 24 24"><path d="M5 12h14"></svg>Weiter</span>`,
    unclosedP: `<p class="lead">{{intro}}`,
    unclosedLi: `<ul>{{#items}}<li>{{label}}{{/items}}`,
    selectActive: `<select aria-label="Sprache">{{#langs}}<option value="{{code}}"{{#active}} selected{{/active}}>{{name}}</option>{{/langs}}</select>`,
    iframe: `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/{{video_id}}" title="{{title}}" allowfullscreen></iframe></div>`,
    form: `<form class="newsletter" action="/api/x"><label>E-Mail <input type="email" name="email" placeholder="{{placeholder}}"></label><button>{{button}}</button></form>`,
    trailingComment: `<div>{{x}}</div><!-- end of hero -->`,
    trailingScript: `<div id="c">{{x}}</div><script>document.getElementById('c').dataset.ready='1'</script>`,
    sectionAttributes: `<a href="{{link}}" {{#external}}target="_blank" rel="noopener"{{/external}}>{{label}}</a>`,
    math: `<p>Formel: <math><mi>x</mi><mo>=</mo><mn>{{n}}</mn></math></p>`,
    dialog: `<dialog id="d"><p>{{text}}</p><form method="dialog"><button>OK</button></form></dialog>`,
    picture: `<picture><source srcset="{{img}} 1x"><img src="{{img}}" alt="{{alt}}"></picture>`,
    video: `<video controls poster="{{poster}}"><source src="{{src}}" type="video/mp4"></video>`,
    template: `<template id="row"><li>{{label}}</li></template><ul></ul>`,
    noscriptImg: `<noscript><img src="{{pixel}}" alt=""></noscript>`,
    textarea: `<textarea name="msg" placeholder="{{ph}}"></textarea>`,
    mustacheComment: `<div>{{! layout hint }}<p>{{x}}</p></div>`,
    tableNoTbody: `<table><tr><td>{{a}}</td></tr></table><p>{{b}}</p>`,
    partial: `<div class="wrap">{{>teaser}}</div>`,
    hN: `<h{{n}}>{{x}}</h{{n}}>`,
  };
  // Each ends outside content, in this reading or in a render.
  const outside: Record<string, string> = {
    svgOpen: `<div><svg viewBox="0 0 10 10"><circle r="4"/>`,
    // Empty, `class=` takes `title="a` and the tag ends at its `>`.
    emptyValueMovesTagEnd: `<div class={{v}} title="a ><noscript>">x</div>`,
    emptyValueMovesTagEndSingle: `<img alt={{a}} data-x='p >'><textarea>`,
    sectionLeavesOpen: `<textarea>{{#a}}</textarea>{{/a}}`,
    partialInRawText: `<textarea>{{>c}}<noscript></textarea>`,
    endTagValue: `<textarea></{{e}}><noscript></textarea>`,
    startTagValue: `<{{t}}>x</{{t}}>`,
    delimiters: `{{=<% %>=}}<p><%x%></p>`,
    unclosedSection: `{{#a}}<p>x</p>`,
    // No tag at all: a browser keeps the `<noscript>` in the `<select>`.
    selectWithoutTags: `<select><div><noscript></select>`,
  };

  it("1: reads every shape real modules use as ending in content", () => {
    const wrong = Object.entries(inContent).filter(([, html]) => !templateEndsInContent(html));
    expect(wrong.map(([name]) => name)).toEqual([]);
  });

  it("1: still reads a module that ends, or may end, outside content as open", () => {
    const wrong = Object.entries(outside).filter(([, html]) => templateEndsInContent(html));
    expect(wrong.map(([name]) => name)).toEqual([]);
  });

  it("1: an unquoted value refuses its own module's later plugin values, not the page's", () => {
    const layout =
      '<main><caelo-slot name="content"></caelo-slot></main><footer><caelo-slot name="foot"></caelo-slot></footer>';
    const image = {
      ...notice(owned("Titel", "text"), "m-img", '<img src="/a.png" alt={{alt}} title="{{body}}">'),
      fields: [
        { name: "alt", kind: "text" as const },
        { name: "body", kind: "text" as const },
      ],
      contentValues: { alt: "Bild", body: owned("Titel", "text") },
    };
    const out = page(
      layout,
      [{ blockName: "foot", modules: [notice(owned("<p>Fuß</p>"))] }],
      image,
    );
    expect(reasons(out)).toEqual([refused("context-conditional-markup")]);
    expect(out.html).toContain("<p>Fuß</p>");
  });

  // The teaser a mega menu's promo entry embeds ends in an open <noscript>.
  const teaser: NestedRenderResolver = {
    getModule: (moduleId) =>
      moduleId === MODULE.teaser
        ? {
            moduleId,
            slug: "teaser",
            html: '<div class="teaser"><noscript>Bitte JS aktivieren',
            css: "",
            js: "",
            fields: [],
          }
        : null,
    getContentInstance: (id) =>
      id === INSTANCE.teaser ? { id, moduleId: MODULE.teaser, values: {}, deletedAt: null } : null,
  };
  const navWith = (field: Record<string, unknown>, value?: unknown) => ({
    ...notice(owned(ESCAPE), "m-nav"),
    html: '<nav>{{#mega}}{{#columns}}{{>teaser}}{{/columns}}{{/mega}}</nav><div class="hint">{{body}}</div>',
    fields: [
      { name: "mega", kind: "list" as const, listType: "mega-menu", ...field },
      { name: "body", kind: "richtext" as const },
    ],
    contentValues: { body: owned(ESCAPE), ...(value === undefined ? {} : { mega: value }) },
  });
  const composeNav = (module: ReturnType<typeof navWith>) =>
    composePageWithLayout({
      layoutHtml: '<main><caelo-slot name="content"></caelo-slot></main>',
      layoutCss: "",
      layoutBlocks: [],
      templateHtml: '<caelo-slot name="content"></caelo-slot>',
      templateCss: "",
      blocks: [{ blockName: "content", modules: [module] as ReturnType<typeof notice>[] }],
      lists: createListRenderContext(fixtureData()).forPage(PAGE.home, {}),
      nestedModules: teaser,
    });

  it("2: a module a shared list entry embeds is read too", () => {
    const out = composeNav(navWith({ bind: "shared", list: `caelo:list/${LIST.mega}` }));
    expect(out.html).toContain("<noscript>Bitte JS aktivieren");
    expect(reasons(out)).toContain(refused(OPEN_MARKUP_RULE));
    expect(out.html).not.toContain("onerror=alert(1)>");
    expect(out.openMarkup).toBe(true);
  });

  it("2: so is one a content variant's local list embeds", () => {
    const entries = [
      {
        id: ITEM.products,
        node: "entry",
        values: { label: "Produkte" },
        children: [
          {
            id: ITEM.promo,
            node: "promo",
            values: {
              title: "Neu",
              teaser: { moduleId: MODULE.teaser, contentInstanceId: INSTANCE.teaser },
            },
          },
        ],
      },
    ];
    const variant = pluginLocalList({ plugin: "evil", address: "page:content:0/mega" }, entries);
    const out = composeNav(navWith({}, variant));
    expect(out.html).toContain("<noscript>Bitte JS aktivieren");
    expect(reasons(out)).toContain(refused(OPEN_MARKUP_RULE));
    expect(out.html).not.toContain("onerror=alert(1)>");
  });
});

/**
 * #1732 review, round 5 — a value the reading treats as a word may render
 * empty (or as `-`, `!`, `]]`) and so end the raw text or comment it
 * stands in; and a withheld module's placeholder is markup the page shows.
 */
describe("values that may end raw text or a comment, and placeholders (#1732 review, round 5)", () => {
  const textField = (name: string) => ({ name, kind: "text" as const });
  const renderWith = (html: string, values: Record<string, unknown>) =>
    renderTemplate({
      html,
      fields: ["x", "v", "note"].map(textField),
      contentValues: { x: owned("alert(1)", "text"), ...values },
    });

  // Each runs `alert(1)` in Chromium with the value shown, when `x` is not refused.
  const ending: Record<string, [string, string]> = {
    textareaEndTag: [`<textarea><{{v}}/textarea><img src=x onerror="{{x}}"></textarea>`, ""],
    noscriptEndTag: [`<noscript><{{v}}/noscript><img src=x onerror="{{x}}"></noscript>`, ""],
    scriptEndTag: [`<script>/*<{{v}}/script><img src=x onerror="{{x}}">*/</script>`, ""],
    commentAbrupt: [`<!--{{v}}-><img src=x onerror="{{x}}">-->`, ""],
    commentDash: [`<!-- n -{{v}}-><img src=x onerror="{{x}}"> -->`, ""],
    commentDashSpelled: [`<!-- n -{{v}}-><img src=x onerror="{{x}}"> -->`, "-"],
    commentBang: [`<!-- n --{{v}}><img src=x onerror="{{x}}"> -->`, "!"],
    commentStart: [`<!{{v}}-- <p title="x>"> --><img src=x onerror="{{x}}">`, ""],
    tagNameComment: [`<{{v}}!-- --><img src=x onerror="{{x}}">`, ""],
    scriptEscape: [
      `<script><!{{v}}--<script>/*</script><img src=x onerror="{{x}}">*/</script></script>`,
      "",
    ],
  };

  it("1: refuses the plugin values after such a value and counts the module as open", () => {
    for (const [name, [html, v]] of Object.entries(ending)) {
      const r = renderWith(html, { v });
      expect({
        name,
        refused: r.missingSlots.some((m) => m.startsWith("plugin-value-refused")),
      }).toEqual({
        name,
        refused: true,
      });
      expect({ name, html: r.html.includes('onerror="alert(1)"') }).toEqual({ name, html: false });
      expect({ name, ends: templateEndsInContent(html) }).toEqual({ name, ends: false });
    }
  });

  it("1: keeps values in comments, raw text and RCDATA that cannot end them", () => {
    for (const html of [
      `<!-- {{note}} --><p title="{{x}}">p</p>`,
      `<!--{{note}}--><p title="{{x}}">p</p>`,
      `<textarea>{{note}}</textarea><p title="{{x}}">p</p>`,
      `<title>{{note}} | Site</title><p title="{{x}}">p</p>`,
      `<script>var u = "/{{note}}"; var n = 1-{{note}};</script><p title="{{x}}">p</p>`,
      `<noscript><img src="/{{note}}.gif" alt=""></noscript><p title="{{x}}">p</p>`,
    ]) {
      const r = renderWith(html, { note: "" });
      expect({ html, missing: r.missingSlots }).toEqual({ html, missing: [] });
      expect({ html, ends: templateEndsInContent(html) }).toEqual({ html, ends: true });
    }
  });

  it("1: in SVG, an empty value that drops a tag's closing `/` leaves the tag open", () => {
    expect(templateEndsInContent(`<svg><foreignObject r={{v}} /></svg>`)).toBe(false);
    expect(templateEndsInContent(`<img src="/a.png" alt={{alt}} />`)).toBe(true);
  });

  const withheld = (placeholderHtml: string) => {
    const VIDEO = "00000000-0000-4000-8000-000000000a01";
    return composePageWithLayout({
      layoutHtml:
        '<!doctype html><html><head></head><body><caelo-slot name="content"></caelo-slot></body></html>',
      layoutCss: "",
      layoutBlocks: [],
      templateHtml: '<main><caelo-slot name="content"></caelo-slot></main>',
      templateCss: "",
      blocks: [
        {
          blockName: "content",
          modules: [
            { ...notice("x", VIDEO, '<div class="video">yt</div>'), fields: [] },
            notice(owned(ESCAPE), "m-hint", '<div class="hint">{{body}}</div>'),
          ],
        },
      ],
      nestedModules: { getModule: () => null, getContentInstance: () => null },
      deferredModules: {
        [VIDEO]: {
          pluginSlug: "consent",
          reason: "consent",
          placeholderModuleSlug: "consent-ph",
          placeholderHtml,
          placeholderCss: "",
        },
      },
    });
  };

  it("2: a withheld module's placeholder that ends outside content refuses every plugin value", () => {
    const out = withheld('<div class="consent-ph"><noscript>Bitte JS aktivieren');
    expect(out.openMarkup).toBe(true);
    expect(reasons(out)).toContain(refused(OPEN_MARKUP_RULE));
    expect(out.html).not.toContain("onerror=alert(1)>");
  });

  it("2: one that ends in content keeps them", () => {
    const out = withheld('<div class="consent-ph">Video laden</div>');
    expect(out.openMarkup).toBe(false);
    expect(reasons(out)).toEqual([]);
  });
});
