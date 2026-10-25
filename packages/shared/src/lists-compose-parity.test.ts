// SPDX-License-Identifier: MPL-2.0

/**
 * Preview / generator parity for lists (epic #1107, #1110 acceptance):
 * a mega menu (entry → column / news feed / promo → sub link, with an
 * embedded teaser module) rendered as a LAYOUT chrome placement and
 * inside a NESTED module, composed the way the editor preview does it
 * (page modules pre-rendered with `renderModuleWithContent`, chrome
 * through the composer) and the way the static generator does it
 * (everything through the composer with a `nestedModules` resolver).
 * Same input, same HTML.
 */

import { describe, expect, it } from "bun:test";
import {
  fixtureData,
  fixtureLinkIndex,
  INSTANCE,
  ITEM,
  LIST,
  MODULE,
  PAGE,
} from "./lists/list-fixtures.test.js";
import { createListRenderContext } from "./lists/resolve.js";
import {
  type NestedContentInstanceResource,
  type NestedModuleResource,
  type NestedRenderResolver,
  renderModuleWithContent,
} from "./nested-module-render.js";
import { type ComposeModule, composePageWithLayout } from "./preview-compose.js";
import type { TemplateField } from "./template-engine.js";

const HEADER_MOD = "00000000-0000-4000-8000-000000000311";
const WRAPPER_MOD = "00000000-0000-4000-8000-000000000312";
const HEADER_CI = "00000000-0000-4000-8000-000000000411";
const WRAPPER_CI = "00000000-0000-4000-8000-000000000412";

const MEGA_HTML =
  '<nav class="mega"><ul>{{#mega}}<li class="{{#is_current}}current{{/is_current}}{{#is_ancestor}}open{{/is_ancestor}}">' +
  '<a href="{{link}}">{{label}}</a>' +
  '{{#has_columns}}<div class="panel">{{#columns}}' +
  '{{#is_column}}<div class="col"><h4>{{heading}}</h4><ul>{{#links}}<li><a href="{{link}}">{{label}}</a>{{#badge_hot}}!{{/badge_hot}}</li>{{/links}}</ul></div>{{/is_column}}' +
  '{{#is_news_feed}}<aside><h4>{{heading}}</h4>{{#items}}<a href="{{link}}">{{title}} · {{published_at.formatted}}</a>{{/items}}{{^items}}No news{{/items}}</aside>{{/is_news_feed}}' +
  '{{#is_promo}}<div class="promo">{{>teaser}}</div>{{/is_promo}}' +
  "{{/columns}}</div>{{/has_columns}}</li>{{/mega}}</ul><p>{{page.title}}</p></nav>";

const HEADER_FIELDS: TemplateField[] = [
  {
    name: "mega",
    kind: "list",
    listType: "mega-menu",
    bind: "shared",
    list: `caelo:list/${LIST.mega}`,
  },
];

const modules: NestedModuleResource[] = [
  {
    moduleId: HEADER_MOD,
    slug: "mega-header",
    html: MEGA_HTML,
    css: ".mega{}",
    js: "",
    fields: HEADER_FIELDS,
  },
  {
    moduleId: MODULE.teaser,
    slug: "teaser",
    html: '<article class="teaser"><h5>{{title}}</h5></article>',
    css: ".teaser{}",
    js: "",
    fields: [{ name: "title", kind: "text" }],
  },
  {
    moduleId: WRAPPER_MOD,
    slug: "wrapper",
    html: '<section class="wrap">{{>inner}}</section>',
    css: ".wrap{}",
    js: "",
    fields: [{ name: "inner", kind: "module" }],
  },
];
const instances: NestedContentInstanceResource[] = [
  {
    id: INSTANCE.teaser,
    moduleId: MODULE.teaser,
    values: { title: "Try it free" },
    deletedAt: null,
  },
  { id: HEADER_CI, moduleId: HEADER_MOD, values: {}, deletedAt: null },
  {
    id: WRAPPER_CI,
    moduleId: WRAPPER_MOD,
    values: { inner: { moduleId: HEADER_MOD, contentInstanceId: HEADER_CI } },
    deletedAt: null,
  },
];
const resolver: NestedRenderResolver = {
  getModule: (id) => modules.find((m) => m.moduleId === id) ?? null,
  getContentInstance: (id) => instances.find((c) => c.id === id) ?? null,
};
const mod = (id: string): NestedModuleResource =>
  modules.find((m) => m.moduleId === id) as NestedModuleResource;

const LAYOUT =
  '<html><head></head><body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body></html>';
const TEMPLATE = '<body><caelo-slot name="content"></caelo-slot></body>';

/** The chrome placement: renders from field defaults, no content instance. */
function chrome(): ComposeModule {
  const m = mod(HEADER_MOD);
  return {
    moduleId: m.moduleId,
    slug: m.slug,
    displayName: "Header",
    html: m.html,
    css: m.css,
    js: m.js,
    fields: m.fields,
  };
}

function contexts(pageId: string) {
  const linkResolver = fixtureLinkIndex().forPage(pageId);
  const lists = createListRenderContext(fixtureData()).forPage(pageId, { linkResolver });
  return { linkResolver, lists };
}

/** The editor preview's path (`pages.render_preview`). */
function previewCompose(pageId: string) {
  const { linkResolver, lists } = contexts(pageId);
  const rendered = renderModuleWithContent(
    WRAPPER_MOD,
    WRAPPER_CI,
    resolver,
    undefined,
    lists,
    linkResolver,
  );
  const w = mod(WRAPPER_MOD);
  const nested = [...rendered.touchedModuleIds].filter((id) => id !== WRAPPER_MOD).map(mod);
  return composePageWithLayout({
    templateHtml: TEMPLATE,
    templateCss: "",
    blocks: [
      {
        blockName: "content",
        modules: [
          {
            moduleId: w.moduleId,
            slug: w.slug,
            displayName: "Wrapper",
            html: rendered.html,
            css: w.css,
            js: w.js,
          },
        ],
      },
      {
        blockName: "__nested__",
        modules: nested.map((n) => ({
          moduleId: n.moduleId,
          slug: n.slug,
          displayName: n.slug,
          html: "",
          css: n.css,
          js: n.js,
        })),
      },
    ],
    layoutHtml: LAYOUT,
    layoutCss: "",
    layoutBlocks: [{ blockName: "header", modules: [chrome()] }],
    nestedModules: resolver,
    lists,
    linkResolver,
  });
}

/** The static generator's path (`generate.ts`). */
function generatorCompose(pageId: string) {
  const { linkResolver, lists } = contexts(pageId);
  const w = mod(WRAPPER_MOD);
  return composePageWithLayout({
    templateHtml: TEMPLATE,
    templateCss: "",
    blocks: [
      {
        blockName: "content",
        modules: [
          {
            moduleId: w.moduleId,
            slug: w.slug,
            displayName: "Wrapper",
            html: w.html,
            css: w.css,
            js: w.js,
            fields: w.fields,
            contentValues: (
              instances.find((c) => c.id === WRAPPER_CI) as NestedContentInstanceResource
            ).values,
            contentInstanceId: WRAPPER_CI,
          },
        ],
      },
    ],
    layoutHtml: LAYOUT,
    layoutCss: "",
    layoutBlocks: [{ blockName: "header", modules: [chrome()] }],
    nestedModules: resolver,
    lists,
    linkResolver,
  });
}

const bodyOf = (html: string) => html.slice(html.indexOf("<body>"), html.indexOf("</body>"));

describe("mega menu — preview / generator parity", () => {
  it("renders the same HTML on both paths, in chrome and inside a nested module", () => {
    const preview = previewCompose(PAGE.team);
    const build = generatorCompose(PAGE.team);
    expect(preview.moduleFailures).toEqual([]);
    expect(build.moduleFailures).toEqual([]);
    expect(bodyOf(preview.html)).toBe(bodyOf(build.html));
    // CSS of every module the lists reached joins the page once on both paths.
    for (const out of [preview, build]) {
      for (const css of [".mega{}", ".teaser{}", ".wrap{}"]) {
        expect(out.html.split(css).length - 1).toBe(1);
      }
    }
  });

  it("renders every node kind with page-aware state", () => {
    const body = bodyOf(generatorCompose(PAGE.team).html);
    // Twice: once in the chrome, once inside the wrapper module.
    expect(body.split('<nav class="mega"').length - 1).toBe(2);
    expect(body).toContain(
      `<li class="open" data-caelo-list-item="${LIST.mega}/${ITEM.products}"><a href="/about/">Products</a>`,
    );
    expect(body).toContain(
      `<div class="col" data-caelo-list-item="${LIST.mega}/${ITEM.column}"><h4>Explore</h4>`,
    );
    expect(body).toContain(
      `<li data-caelo-list-item="${LIST.mega}/${ITEM.subA}"><a href="/about/team/">Team</a></li>`,
    );
    expect(body).toContain(
      '<a href="/news/meetup/">Meetup · October 5, 2026</a><a href="/news/launch/">Launch day · October 1, 2026</a>',
    );
    expect(body).toContain(
      `<div class="promo" data-caelo-list-item="${LIST.mega}/${ITEM.promo}"><article class="teaser" data-caelo-module-id="${MODULE.teaser}"><h5>Try it free</h5></article></div>`,
    );
    expect(body).toContain("<p>Team</p>");
    expect(body).not.toContain("{{");
  });

  it("re-renders per page: the page title and current state follow the rendering page", () => {
    const body = bodyOf(generatorCompose(PAGE.home).html);
    expect(body).toContain("<p>Home</p>");
    expect(body).toContain('<li class=""');
  });
});
