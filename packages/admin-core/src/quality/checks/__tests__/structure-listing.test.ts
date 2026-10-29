// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1256 — `structure/manual-page-listing`: an overview of pages kept
 * as hand-written cards instead of a list field bound to a page query.
 * The fixture is a site with nine published guides (page type `guide`),
 * forty products and ordinary pages of the default type; every way of
 * writing the cards by hand is checked, and every right way stays silent.
 */

import { describe, expect, it } from "bun:test";
import {
  createListRenderContext,
  DEFAULT_LIST_TYPES,
  renderPlacedModule,
  tagModuleId,
} from "@caelo-cms/shared";
import type { StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { structureFindings } from "../structure.js";
import type { StructureModule } from "../structure-analysis.js";
import type { StructurePageIndex } from "../structure-listing.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHARED_LIST = "00000000-0000-4000-8000-000000009000";
const itemId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

const TYPE_PAGE = id(9001);
const TYPE_GUIDE = id(9002);
const TYPE_PRODUCT = id(9003);

interface SitePage {
  readonly n: number;
  readonly path: string;
  readonly title: string;
  readonly type: string;
}

const GUIDES: SitePage[] = Array.from({ length: 9 }, (_, i) => ({
  n: 100 + i,
  path: `/guides/g${i}`,
  title: `Guide ${i}`,
  type: TYPE_GUIDE,
}));
const PRODUCTS: SitePage[] = Array.from({ length: 40 }, (_, i) => ({
  n: 200 + i,
  path: `/products/p${i}`,
  title: `Product ${i}`,
  type: TYPE_PRODUCT,
}));
const ORDINARY: SitePage[] = ["/about", "/team", "/contact", "/jobs"].map((path, i) => ({
  n: 300 + i,
  path,
  title: path.slice(1),
  type: TYPE_PAGE,
}));
const HUB: SitePage = { n: 1, path: "/guides", title: "Guides", type: TYPE_PAGE };
const SITE = [HUB, ...GUIDES, ...PRODUCTS, ...ORDINARY];

const INDEX: StructurePageIndex = {
  defaultPageTypeId: TYPE_PAGE,
  pageTypes: new Map([
    [TYPE_PAGE, { slug: "page", name: "Page" }],
    [TYPE_GUIDE, { slug: "guide", name: "Guide" }],
    [TYPE_PRODUCT, { slug: "product", name: "Product" }],
  ]),
  pages: new Map(SITE.map((p) => [id(p.n), { pageTypeId: p.type, title: p.title }])),
};

// ─── Modules ─────────────────────────────────────────────────────────

/** A local `links` list field: one stamped entry per link. */
const LINK_LIST: StructureModule = {
  id: id(10),
  slug: "link-list",
  displayName: "Link list",
  html: '<section class="ll"><ul>{{#links}}<li><a href="{{link}}">{{label}}</a></li>{{/links}}</ul></section>',
  js: "",
  listFields: ["links"],
};
/** The hub holding cards in a `module-list`. */
const CARD_GRID: StructureModule = {
  id: id(11),
  slug: "card-grid",
  displayName: "Card grid",
  html: '<section class="grid"><h2>{{title}}</h2><div class="cards">{{#cards}}{{/cards}}</div></section>',
  js: "",
  listFields: ["cards"],
};
const CARD: StructureModule = {
  id: id(12),
  slug: "guide-card",
  displayName: "Guide card",
  html: '<article class="card"><h3>{{title}}</h3>{{#href}}<a class="more" href="{{href}}">Read</a>{{/href}}</article>',
  js: "",
  listFields: [],
};
/** Numbered scalar fields — the template owns every link. */
const SCALAR_CARDS: StructureModule = {
  id: id(13),
  slug: "four-cards",
  displayName: "Four cards",
  html:
    '<section class="four">' +
    [1, 2, 3, 4]
      .map((i) => `<div class="c"><a href="{{card${i}_href}}">{{card${i}_title}}</a></div>`)
      .join("") +
    "</section>",
  js: "",
  listFields: [],
};
/** The right way: a list field bound to a page query (entries unstamped). */
const QUERY_LIST: StructureModule = {
  id: id(14),
  slug: "guide-index",
  displayName: "Guide index",
  html: '<section class="gi">{{#guides}}<a class="gi-item" href="{{link}}">{{title}}</a>{{/guides}}</section>',
  js: "",
  listFields: ["guides"],
};
/** A local menu whose entry is a source node generating `items`. */
const MEGA: StructureModule = {
  id: id(15),
  slug: "mega",
  displayName: "Mega menu",
  html: '<nav class="mega">{{#menu}}<div class="col"><a class="top" href="{{link}}">{{label}}</a>{{#items}}<a class="sub" href="{{link}}">{{title}}</a>{{/items}}</div>{{/menu}}</nav>',
  js: "",
  listFields: ["menu"],
};
const MODULES = [LINK_LIST, CARD_GRID, CARD, SCALAR_CARDS, QUERY_LIST, MEGA];

// ─── Rendering helpers (as the template engine and composer stamp) ───

const local = (field: string, n: number) => `local/${field}/${itemId(n)}`;
const shared = (n: number) => `${SHARED_LIST}/${itemId(n)}`;

function linkList(pages: readonly SitePage[], stamp: (n: number) => string): string {
  const lis = pages
    .map((p, i) => `<li data-caelo-list-item="${stamp(i)}"><a href="${p.path}">${p.title}</a></li>`)
    .join("");
  return `<section class="ll" data-caelo-module-id="${LINK_LIST.id}"><ul>${lis}</ul></section>`;
}

function cardGrid(pages: readonly SitePage[]): string {
  const cards = pages
    .map(
      (p) =>
        `<article class="card" data-caelo-module-id="${CARD.id}"><h3>${p.title}</h3><a class="more" href="${p.path}">Read</a></article>`,
    )
    .join("");
  return `<section class="grid" data-caelo-module-id="${CARD_GRID.id}"><h2>All guides</h2><div class="cards">${cards}</div></section>`;
}

function scalarCards(pages: readonly SitePage[]): string {
  const cs = pages.map((p) => `<div class="c"><a href="${p.path}">${p.title}</a></div>`).join("");
  return `<section class="four" data-caelo-module-id="${SCALAR_CARDS.id}">${cs}</section>`;
}

function queryList(pages: readonly SitePage[]): string {
  const items = pages.map((p) => `<a class="gi-item" href="${p.path}">${p.title}</a>`).join("");
  return `<section class="gi" data-caelo-module-id="${QUERY_LIST.id}">${items}</section>`;
}

function page(p: SitePage, ...modules: string[]): StagedPage {
  return {
    pageId: id(p.n),
    path: p.path,
    url: `https://staging.example.test${p.path}`,
    html: `<!doctype html><html><body><main>${modules.join("")}</main></body></html>`,
  };
}

/** The staged build: the hub with `hub`, every other page empty. */
function build(...hub: string[]): StagedPage[] {
  return [page(HUB, ...hub), ...SITE.filter((p) => p !== HUB).map((p) => page(p))];
}

function listing(pages: readonly StagedPage[], index = INDEX) {
  return structureFindings(pages, MODULES, [], index).filter(
    (f) => f.ruleId === "structure/manual-page-listing",
  );
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("structure/manual-page-listing (#1256)", () => {
  it("a local list of 7 of 9 guides is an error naming the missing guides and the fix", () => {
    const findings = listing(build(linkList(GUIDES.slice(0, 7), (n) => local("links", n))));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f).toMatchObject({ severity: "error", pageId: id(HUB.n) });
    expect(f?.message).toStartWith("Manual page listing:");
    expect(f?.message).toContain(`"Link list" (${LINK_LIST.id})`);
    expect(f?.message).toContain('7 of 9 published pages of type "Guide" (guide)');
    expect(f?.message).toContain('"Guide 7" (/guides/g7)');
    expect(f?.message).toContain('"Guide 8" (/guides/g8)');
    expect(f?.fix?.tool).toBe("update_modules_many");
    expect(f?.fix?.hint).toContain('page_type:"guide"');
    expect(f?.fix?.hint).toContain('bind:"source"');
    expect(() => findingSchema.parse(f)).not.toThrow();
  });

  it("a module-list of card modules is one listing; the complete set is a warning", () => {
    const findings = listing(build(cardGrid(GUIDES)));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", pageId: id(HUB.n) });
    expect(findings[0]?.message).toContain(`"Card grid" (${CARD_GRID.id})`);
    expect(findings[0]?.message).toContain("links all 9 published pages");
  });

  it("numbered scalar href fields count (template-owned links)", () => {
    const f = listing(build(scalarCards(GUIDES.slice(0, 4).concat(GUIDES.slice(5, 6)))));
    expect(f.map((x) => x.severity)).toEqual(["error"]);
    expect(f[0]?.message).toContain("5 of 9");
    expect(f[0]?.message).toContain('"Guide 4" (/guides/g4)');
  });

  it("below half of the type stays silent, even across two placements on one page", () => {
    expect(
      listing(build(scalarCards(GUIDES.slice(0, 4)), scalarCards(GUIDES.slice(4, 8)))),
    ).toEqual([]);
  });

  it("a curated top 3 of 40 products stays allowed", () => {
    expect(listing(build(linkList(PRODUCTS.slice(0, 3), (n) => local("links", n))))).toEqual([]);
  });

  it("links to pages of the default page type are ordinary link groups", () => {
    expect(listing(build(linkList(ORDINARY, (n) => local("links", n))))).toEqual([]);
  });

  it("entries of a shared list (a menu) never count", () => {
    expect(listing(build(linkList(GUIDES, shared)))).toEqual([]);
  });

  it("entries a page query generates never count", () => {
    expect(listing(build(queryList(GUIDES)))).toEqual([]);
  });

  it("a source node's generated items inside a stored menu entry never count", () => {
    const sub = GUIDES.map((p) => `<a class="sub" href="${p.path}">${p.title}</a>`).join("");
    const mega = `<nav class="mega" data-caelo-module-id="${MEGA.id}"><div class="col" data-caelo-list-item="${local("menu", 0)}"><a class="top" href="/guides">Guides</a>${sub}</div></nav>`;
    expect(listing(build(mega))).toEqual([]);
  });

  it("hand-written links in a field value count like a local list", () => {
    const TEXT: StructureModule = {
      id: id(16),
      slug: "text",
      displayName: "Text",
      html: '<section class="prose">{{body}}</section>',
      js: "",
      listFields: [],
    };
    const body = GUIDES.slice(0, 6)
      .map((p) => `<p><a href="${p.path}">${p.title}</a></p>`)
      .join("");
    const pages = build(
      `<section class="prose" data-caelo-module-id="${TEXT.id}">${body}</section>`,
    );
    const f = structureFindings(pages, [...MODULES, TEXT], [], INDEX).filter(
      (x) => x.ruleId === "structure/manual-page-listing",
    );
    expect(f.map((x) => x.severity)).toEqual(["error"]);
  });

  it("a hub of the listed type does not list itself", () => {
    const [first, ...rest] = GUIDES as [SitePage, ...SitePage[]];
    const pages = [
      page(
        first,
        linkList(rest, (n) => local("links", n)),
      ),
      ...SITE.filter((p) => p !== first).map((p) => page(p)),
    ];
    const f = listing(pages);
    expect(f.map((x) => x.severity)).toEqual(["warning"]);
    expect(f[0]?.message).toContain("links all 8 published pages");
  });

  it("the same chrome listing on every page is one finding without a page", () => {
    const footer = linkList(GUIDES, (n) => local("links", n));
    const pages = SITE.map((p) => page(p, footer));
    const f = listing(pages);
    expect(f).toHaveLength(1);
    expect(f[0]?.pageId).toBeUndefined();
    expect(f[0]?.message).toContain(`on ${pages.length} pages`);
  });

  it("links to another site or to a fragment are no listing", () => {
    const ext = `<section class="ll" data-caelo-module-id="${LINK_LIST.id}"><ul>${GUIDES.map(
      (p, i) =>
        `<li data-caelo-list-item="${local("links", i)}"><a href="https://other.test${p.path}">x</a></li>`,
    ).join("")}</ul></section>`;
    expect(listing(build(ext))).toEqual([]);
  });

  it("a local list rendered by the real template engine is stamped and counted", () => {
    const lists = createListRenderContext({
      listTypes: new Map(DEFAULT_LIST_TYPES.map((t) => [t.slug, { id: t.slug, def: t }])),
      lists: new Map(),
      pageTypes: new Map(),
      pages: new Map(),
      media: new Map(),
      siteLanguage: "en",
      homePageId: null,
    }).forPage(null);
    const rendered = renderPlacedModule(
      {
        html: LINK_LIST.html,
        fields: [{ name: "links", kind: "list", listType: "links" }],
        values: {
          links: GUIDES.slice(0, 8).map((p, i) => ({
            id: itemId(i),
            node: "link",
            values: { label: p.title, link: { href: p.path } },
          })),
        },
      },
      { getModule: () => null, getContentInstance: () => null },
      { lists },
    );
    expect(rendered.failures).toEqual([]);
    expect(rendered.html).toContain("data-caelo-list-item=");
    const f = listing(build(tagModuleId(rendered.html, LINK_LIST.id)));
    expect(f.map((x) => [x.severity, x.message.includes("8 of 9")])).toEqual([["error", true]]);
  });
});
