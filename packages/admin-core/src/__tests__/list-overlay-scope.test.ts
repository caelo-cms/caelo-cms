// SPDX-License-Identifier: MPL-2.0

/**
 * #1223 — what one previewed page can show from lists: the scope of its
 * `list-resolve` call, or null when it shows nothing an overlay changes.
 */

import { describe, expect, it } from "bun:test";
import type { ListPageRecord, ListRenderData, ListTypeDef, TemplateField } from "@caelo-cms/shared";
import { pageListOverlayScope, type ScopedModule } from "../lists/overlay-scope.js";

const P = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CI = "00000000-0000-4000-9000-000000000001";

function page(id: string, pageTypeSlug: string): ListPageRecord {
  return {
    id,
    title: id,
    shortTitle: id,
    parentId: null,
    pageTypeSlug,
    properties: {},
    terms: [],
    firstPublishedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    summary: null,
    image: null,
    inBuild: true,
  } as ListPageRecord;
}

function listType(slug: string, source?: { kind: string; name?: string }): ListTypeDef {
  return {
    slug,
    name: slug,
    purpose: slug,
    role: "content",
    root: { allow: ["entry"] },
    nodes: {
      entry: { label: "Entry", fields: [{ name: "label", label: "Label", type: "text" }] },
      ...(source ? { feed: { label: "Feed", fields: [], source } } : {}),
    },
  } as ListTypeDef;
}

/** P(1) en (product), P(2) de (product), P(3) de (plain), P(4) de (product). */
const data = {
  listTypes: new Map([
    ["nav", { id: "t1", def: listType("nav") }],
    ["feed", { id: "t2", def: listType("feed", { kind: "query" }) }],
    ["langs", { id: "t3", def: listType("langs", { kind: "plugin", name: "language_links" }) }],
  ]),
  lists: new Map([
    ["l2", { id: "l2", slug: "footer", name: "Footer", typeSlug: "nav", items: [] }],
    ["l1", { id: "l1", slug: "menu", name: "Menu", typeSlug: "nav", items: [] }],
  ]),
  pageTypes: new Map([
    [
      "product",
      {
        id: "pt1",
        def: { slug: "product", properties: [{ name: "tagline", label: "T", type: "text" }] },
      },
    ],
    ["plain", { id: "pt2", def: { slug: "plain", properties: [] } }],
  ]),
  pages: new Map([
    [P(1), page(P(1), "product")],
    [P(2), page(P(2), "product")],
    [P(3), page(P(3), "plain")],
    [P(4), page(P(4), "product")],
  ]),
  media: new Map(),
  pageVariants: new Map([
    [P(1), { variant: "en", group: "g1" }],
    [P(2), { variant: "de", group: "g1" }],
    [P(3), { variant: "de", group: null }],
    [P(4), { variant: "de", group: "g2" }],
  ]),
  siteLanguage: "en",
  homePageId: null,
} as unknown as ListRenderData;

const field = (f: Partial<TemplateField> & { name: string }): TemplateField =>
  ({ kind: "text", ...f }) as TemplateField;
const mod = (fields: TemplateField[], html = ""): ScopedModule => ({ fields, html });

function scopeOf(modules: ScopedModule[], markup: string[] = []) {
  return pageListOverlayScope({
    pageId: P(2),
    data,
    modules,
    markup,
    contentInstanceIds: [CI, CI],
  });
}

describe("pageListOverlayScope (#1223)", () => {
  it("is null for a page that shows no list, no page value and no site text", () => {
    expect(scopeOf([mod([field({ name: "title" })], "<h1>{{title}}</h1>")])).toBeNull();
  });

  it("covers every shared list, the page's instances and the page itself", () => {
    expect(scopeOf([mod([field({ name: "items", kind: "list", listType: "nav" })])])).toEqual({
      listIds: ["l1", "l2"],
      contentInstanceIds: [CI],
      pageIds: [P(2)],
    });
  });

  it("counts `page.*` and `site_text.*` in any markup as a list read", () => {
    const plain = [mod([field({ name: "title" })], "<h1>{{title}}</h1>")];
    expect(scopeOf([mod([], "<p>{{ PAGE.props.tagline }}</p>")])?.pageIds).toEqual([P(2)]);
    expect(scopeOf(plain, ["<footer>{{site_text.copyright}}</footer>"])).not.toBeNull();
  });

  it("adds the variant's pages with properties when a list generates page entries", () => {
    const query = scopeOf([mod([field({ name: "news", kind: "list", listType: "feed" })])]);
    // P(3) has no properties, P(1) is in another variant.
    expect(query?.pageIds).toEqual([P(2), P(4)]);
    const bound = scopeOf([
      mod([
        field({
          name: "kids",
          kind: "list",
          bind: "source",
          source: { kind: "system", name: "children" },
        } as never),
      ]),
    ]);
    expect(bound?.pageIds).toEqual([P(2), P(4)]);
  });

  it("a plugin source generates no pages", () => {
    const langs = scopeOf([mod([field({ name: "langs", kind: "list", listType: "langs" })])]);
    expect(langs?.pageIds).toEqual([P(2)]);
  });
});
