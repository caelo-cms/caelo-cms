// SPDX-License-Identifier: MPL-2.0

/**
 * The list resolver (epic #1107, `docs/lists.md` §6, §9, §10): every
 * source kind, query knobs, variant scoping, overlays (replace, hide,
 * refused changes) and the render dependencies a page records.
 */

import { describe, expect, it } from "bun:test";
import type { LinkPageVariant } from "../link-refs.js";
import {
  fixtureData,
  fixtureLinkIndex,
  ITEM,
  LIST,
  PAGE,
  PAGES,
  TERM,
} from "./list-fixtures.test.js";
import type { QueryKnob } from "./list-type.js";
import type { ListPageRecord, ListVariantOverlay, LoadedList } from "./render-data.js";
import {
  createListRenderContext,
  type ListFieldSpec,
  type ListPageContext,
  type ListRenderContextOptions,
} from "./resolve.js";
import type { ScopeEntry } from "./scope.js";

function page(
  pageId: string | null,
  data = fixtureData(),
  opts: ListRenderContextOptions = {},
): ListPageContext {
  return createListRenderContext(data, opts).forPage(pageId, {
    linkResolver: fixtureLinkIndex(data.pageVariants).forPage(pageId),
  });
}

function entries(
  ctx: ListPageContext,
  field: ListFieldSpec,
  value?: unknown,
): readonly ScopeEntry[] {
  const r = ctx.resolveField(field, value, { contentInstanceId: null });
  if (!r.ok) throw new Error(r.marker);
  return r.entries;
}

const textOf = (e: ScopeEntry, key: string): string => {
  const v = e.get(key);
  if (v?.kind === "text") return v.text;
  if (v?.kind === "record") return v.text ?? "";
  throw new Error(`${key} is ${v?.kind}`);
};

const query = (defaults: Record<string, unknown>, editable: QueryKnob[] = []): ListFieldSpec => ({
  name: "q",
  listType: "links",
  bind: "source",
  source: { kind: "query", editable, defaults },
});

describe("query sources", () => {
  it("returns published pages of a type, newest first, excluding drafts", () => {
    const got = entries(
      page(PAGE.home),
      query({ page_type: "news", order: "published_desc", limit: 10 }),
    );
    expect(got.map((e) => textOf(e, "title"))).toEqual(["Meetup", "Launch day"]);
  });

  it("excludes the rendering page by default, includes it with exclude_current: false", () => {
    const base = { page_type: "news", order: "title_asc", limit: 10 };
    expect(entries(page(PAGE.newsA), query(base)).map((e) => e.id)).toEqual([PAGE.newsB]);
    expect(
      entries(page(PAGE.newsA), query({ ...base, exclude_current: false })).map((e) => e.id),
    ).toEqual([PAGE.newsA, PAGE.newsB]);
  });

  it("filters by terms (any / all) and parent", () => {
    const any = query({ terms: [TERM.release, TERM.event], order: "title_asc", limit: 10 });
    expect(entries(page(PAGE.home), any).map((e) => textOf(e, "title"))).toEqual([
      "Launch day",
      "Meetup",
    ]);
    const all = query({
      terms: [TERM.release, TERM.event],
      terms_mode: "all",
      order: "title_asc",
      limit: 10,
    });
    expect(entries(page(PAGE.home), all)).toEqual([]);
    const kids = query({ parent: `caelo:page/${PAGE.about}`, order: "title_asc", limit: 10 });
    expect(entries(page(PAGE.home), kids).map((e) => textOf(e, "title"))).toEqual(["Team"]);
  });

  it("orders by a property and applies the limit", () => {
    const q = query({ page_type: "news", order: "prop_desc:rating", limit: 1 });
    expect(entries(page(PAGE.home), q).map((e) => textOf(e, "title"))).toEqual(["Meetup"]);
  });

  it("applies the placement's overrides only for editable knobs", () => {
    const q = query({ page_type: "news", order: "published_desc", limit: 3 }, ["limit"]);
    expect(entries(page(PAGE.home), q, { limit: 1 })).toHaveLength(1);
    const r = page(PAGE.home).resolveField(q, { page_type: "page" }, { contentInstanceId: null });
    expect(r).toEqual({ ok: false, marker: "list-malformed:q[query.page_type]" });
  });

  it("an incomplete query (no order / limit) is malformed, never guessed", () => {
    const r = page(PAGE.home).resolveField(query({ page_type: "news" }), undefined, {
      contentInstanceId: null,
    });
    expect(r).toEqual({ ok: false, marker: "list-malformed:q[query]" });
  });

  it("returns only pages of the rendering page's variant", () => {
    const pageVariants = new Map<string, LinkPageVariant>([
      [PAGE.home, { variant: "en", group: null }],
      [PAGE.newsA, { variant: "en", group: null }],
      [PAGE.newsB, { variant: "de", group: null }],
    ]);
    const q = query({ page_type: "news", order: "title_asc", limit: 10 });
    const got = entries(page(PAGE.home, fixtureData({ pageVariants })), q);
    expect(got.map((e) => e.id)).toEqual([PAGE.newsA]);
  });
});

describe("system sources", () => {
  const sys = (name: "breadcrumbs" | "children" | "siblings"): ListFieldSpec => ({
    name,
    listType: "links",
    bind: "source",
    source: { kind: "system", name },
  });

  it("breadcrumbs run home → root → current", () => {
    expect(entries(page(PAGE.team), sys("breadcrumbs")).map((e) => textOf(e, "title"))).toEqual([
      "Home",
      "About",
      "Team",
    ]);
  });

  it("children are the published children in title order", () => {
    expect(entries(page(PAGE.news), sys("children")).map((e) => textOf(e, "title"))).toEqual([
      "Launch day",
      "Meetup",
    ]);
  });

  it("siblings include the current page, marked is_current", () => {
    const got = entries(page(PAGE.newsA), sys("siblings"));
    expect(got.map((e) => textOf(e, "title"))).toEqual(["Launch day", "Meetup"]);
    expect(got.map((e) => e.get("is_current"))).toEqual([
      { kind: "bool", value: true },
      { kind: "bool", value: false },
    ]);
  });

  it("outside any page, page-shaped system sources are empty", () => {
    expect(entries(page(null), sys("breadcrumbs"))).toEqual([]);
  });
});

describe("overlays (list-resolve)", () => {
  const variants = new Map<string, LinkPageVariant>([[PAGE.home, { variant: "de", group: null }]]);
  const HEADER: ListFieldSpec = {
    name: "menu",
    listType: "menu",
    bind: "shared",
    list: `caelo:list/${LIST.header}`,
  };
  const overlay = (
    values: [string, unknown][],
    hidden: string[] = [],
  ): ReadonlyMap<string, ListVariantOverlay> =>
    new Map([["de", { values: new Map(values), hidden: new Set(hidden) }]]);

  it("replaces values and hides entries for the rendering page's variant", () => {
    const data = fixtureData({
      pageVariants: variants,
      overlays: overlay(
        [[`list/${LIST.header}/item/${ITEM.home}/label`, "Start"]],
        [`list/${LIST.header}/item/${ITEM.newsEntry}`],
      ),
    });
    const got = entries(page(PAGE.home, data), HEADER);
    expect(got.map((e) => textOf(e, "label"))).toEqual(["Start", "About"]);
    expect(got[1]?.get("last")).toEqual({ kind: "bool", value: true });
    // Another variant's page sees the stored list.
    expect(entries(page(PAGE.about, data), HEADER).map((e) => textOf(e, "label"))).toEqual([
      "Home",
      "About",
      "News",
    ]);
  });

  it("drops and reports unknown addresses, structural and invalid changes", () => {
    const ctx = createListRenderContext(
      fixtureData({
        pageVariants: variants,
        overlays: overlay(
          [
            [`list/${LIST.header}/item/${ITEM.home}/ghost`, "x"],
            [`list/${LIST.header}/item/00000000-0000-4000-8000-999999999999/label`, "x"],
            [`list/${LIST.header}/item/${ITEM.home}/link`, { nope: true }],
            [
              `list/${LIST.mega}/item/${ITEM.promo}/teaser`,
              { moduleId: "x", contentInstanceId: "y" },
            ],
            ["nonsense", "x"],
          ],
          [`list/${LIST.header}/item/00000000-0000-4000-8000-999999999999`],
        ),
      }),
    );
    expect(ctx.overlayIssues.map((i) => i.reason)).toEqual([
      "the entry's node declares no such field",
      "no such list entry",
      expect.stringContaining('"link" must be'),
      "a module field changes structure, an overlay may only replace values",
      "not a rendered value address",
      "no such list entry",
    ]);
    const got = entries(ctx.forPage(PAGE.home), HEADER);
    expect(got.map((e) => textOf(e, "label"))).toEqual(["Home", "About", "News"]);
  });

  it("replaces local list values by instance address and reports unknown fields", () => {
    const ci = "00000000-0000-4000-8000-000000000999";
    const itemId = "00000000-0000-4000-9000-000000000001";
    const data = fixtureData({
      pageVariants: variants,
      overlays: overlay([
        [`instance/${ci}/bullets/item/${itemId}/text`, "Schnell"],
        [`instance/${ci}/bullets/item/${itemId}/ghost`, "x"],
      ]),
    });
    const ctx = page(PAGE.home, data);
    const r = ctx.resolveField(
      { name: "bullets", listType: "texts" },
      [{ id: itemId, node: "text", values: { text: "Fast" } }],
      { contentInstanceId: ci },
    );
    if (!r.ok) throw new Error(r.marker);
    expect(textOf(r.entries[0] as ScopeEntry, "text")).toBe("Schnell");
    expect(ctx.overlayIssues().map((i) => i.address)).toEqual([
      `instance/${ci}/bullets/item/${itemId}/ghost`,
    ]);
  });
});

describe("render dependencies", () => {
  it("records shared lists, types, queries and page-tree reads", () => {
    const ctx = page(PAGE.team);
    entries(ctx, {
      name: "menu",
      listType: "menu",
      bind: "shared",
      list: `caelo:list/${LIST.header}`,
    });
    entries(ctx, query({ page_type: "news", terms: [TERM.event], order: "title_asc", limit: 3 }));
    entries(ctx, {
      name: "b",
      listType: "links",
      bind: "source",
      source: { kind: "system", name: "breadcrumbs" },
    });
    expect(ctx.deps()).toEqual({
      lists: [LIST.header],
      listTypes: ["menu"],
      queries: [{ pageType: "news", terms: [TERM.event], parent: null }],
      pageTree: true,
      // The breadcrumb trail's pages (home included): their values render as entries.
      pages: [PAGE.home, PAGE.about, PAGE.team].sort(),
    });
  });

  it("records only what the render reached (lazy)", () => {
    const ctx = page(PAGE.home);
    const mega = entries(ctx, {
      name: "mega",
      listType: "mega-menu",
      bind: "shared",
      list: `caelo:list/${LIST.mega}`,
    });
    expect(ctx.deps().queries).toEqual([]);
    const columns = mega[0]?.get("columns");
    if (columns?.kind !== "list") throw new Error("columns");
    columns.entries[1]?.get("items");
    expect(ctx.deps().queries).toEqual([{ pageType: "news", terms: [], parent: null }]);
  });

  it("term reads record the vocabulary list", () => {
    const ctx = page(PAGE.newsA);
    const scope = ctx.pageScope();
    if (scope?.kind !== "record") throw new Error("page scope");
    const terms = scope.get("terms");
    if (terms?.kind !== "record") throw new Error("terms");
    terms.get("tags");
    expect(ctx.deps().lists).toEqual([LIST.tags]);
  });
});

describe("breadcrumbs (#1142)", () => {
  const CRUMBS: ListFieldSpec = {
    name: "crumbs",
    listType: "links",
    bind: "source",
    source: { kind: "system", name: "breadcrumbs" },
  };
  const at = (id: string): ListPageRecord => PAGES.find((p) => p.id === id) as ListPageRecord;
  const withShort = (id: string, shortTitle: string): ListPageRecord => ({ ...at(id), shortTitle });

  it("labels crumbs with the short title and marks every crumb but the last as ancestor", () => {
    const data = fixtureData({
      pages: PAGES.map((p) =>
        p.id === PAGE.home
          ? withShort(PAGE.home, "Start")
          : p.id === PAGE.about
            ? withShort(PAGE.about, "Us")
            : p,
      ),
    });
    const ctx = page(PAGE.team, data);
    const got = entries(ctx, CRUMBS);
    expect(got.map((e) => textOf(e, "short_title"))).toEqual(["Start", "Us", "Team"]);
    expect(got.map((e) => e.get("is_ancestor"))).toEqual([
      { kind: "bool", value: true },
      { kind: "bool", value: true },
      { kind: "bool", value: false },
    ]);
    expect(got.map((e) => e.get("is_current"))).toEqual([
      { kind: "bool", value: false },
      { kind: "bool", value: false },
      { kind: "bool", value: true },
    ]);
    expect(ctx.breadcrumbTrail()).toEqual([PAGE.home, PAGE.about, PAGE.team]);
    expect(ctx.deps().pageTree).toBe(true);
    expect(ctx.deps().pages).toEqual([PAGE.home, PAGE.about, PAGE.team].sort());
  });

  it("the home page's own trail is the home page alone", () => {
    const ctx = page(PAGE.home);
    expect(entries(ctx, CRUMBS).map((e) => textOf(e, "title"))).toEqual(["Home"]);
    expect(ctx.breadcrumbTrail()).toEqual([PAGE.home]);
  });

  it("without a designated home the trail is the page tree alone", () => {
    const ctx = page(PAGE.team, fixtureData({ homePageId: null }));
    expect(entries(ctx, CRUMBS).map((e) => textOf(e, "title"))).toEqual(["About", "Team"]);
  });

  it("a page that renders no breadcrumbs records no trail", () => {
    expect(page(PAGE.team).breadcrumbTrail()).toBeNull();
  });

  it("follows the page tree as it is: a moved page's trail needs no edit", () => {
    // Team moved from About to News.
    const moved = PAGES.map((p) => (p.id === PAGE.team ? { ...p, parentId: PAGE.news } : p));
    const ctx = page(PAGE.team, fixtureData({ pages: moved }));
    expect(entries(ctx, CRUMBS).map((e) => textOf(e, "title"))).toEqual(["Home", "News", "Team"]);
  });

  describe("variants", () => {
    const HOME_DE = "00000000-0000-4000-8000-0000000000d1";
    const ABOUT_DE = "00000000-0000-4000-8000-0000000000d2";
    const pages = [
      ...PAGES,
      { ...withShort(PAGE.home, "Startseite"), id: HOME_DE },
      { ...withShort(PAGE.about, "Über uns"), id: ABOUT_DE },
    ];
    const pageVariants = new Map<string, LinkPageVariant>([
      [PAGE.home, { variant: "en", group: "g-home" }],
      [PAGE.about, { variant: "en", group: "g-about" }],
      [HOME_DE, { variant: "de", group: "g-home" }],
      [ABOUT_DE, { variant: "de", group: "g-about" }],
    ]);

    it("a variant page's trail starts at the home page's version in that variant", () => {
      const ctx = page(ABOUT_DE, fixtureData({ pages, pageVariants }));
      expect(entries(ctx, CRUMBS).map((e) => textOf(e, "short_title"))).toEqual([
        "Startseite",
        "Über uns",
      ]);
    });

    it("a variant without a version of the home page shows no home crumb", () => {
      const fr = new Map(pageVariants).set(ABOUT_DE, { variant: "fr", group: "g-about" });
      const ctx = page(ABOUT_DE, fixtureData({ pages, pageVariants: fr }));
      expect(entries(ctx, CRUMBS).map((e) => textOf(e, "short_title"))).toEqual(["Über uns"]);
    });
  });
});

describe("site texts (#1142)", () => {
  const SITE_TEXTS = "00000000-0000-4000-8000-0000000000e1";
  const LABEL = "00000000-0000-4000-9000-0000000000e1";
  const MORE = "00000000-0000-4000-9000-0000000000e2";
  const list = (items: LoadedList["items"], id = SITE_TEXTS): LoadedList => ({
    id,
    slug: id === SITE_TEXTS ? "site-texts" : "more-texts",
    name: "Site texts",
    typeSlug: "site-texts",
    items,
  });
  const text = (itemId: string, key: string, value: string) => ({
    id: itemId,
    node: "text",
    values: { key, text: value },
  });
  const read = (ctx: ListPageContext, key: string) => ctx.siteTextScope().get(key);

  it("reads a text by key and records the list as a dependency", () => {
    const ctx = page(
      PAGE.about,
      fixtureData({ lists: [list([text(LABEL, "breadcrumb_label", "Breadcrumb")])] }),
    );
    expect(read(ctx, "breadcrumb_label")).toEqual({ kind: "text", text: "Breadcrumb" });
    expect(ctx.deps().lists).toContain(SITE_TEXTS);
    expect(ctx.deps().listTypes).toContain("site-texts");
  });

  it("an unknown key is loud, never empty", () => {
    const ctx = page(PAGE.about, fixtureData({ lists: [list([])] }));
    expect(read(ctx, "breadcrumb_label")).toEqual({
      kind: "failed",
      marker: "site-text-missing:breadcrumb_label",
    });
  });

  it("a key defined twice is loud", () => {
    const ctx = page(
      PAGE.about,
      fixtureData({
        lists: [
          list([text(LABEL, "read_more", "Read more")]),
          list([text(MORE, "read_more", "More")], "00000000-0000-4000-8000-0000000000e2"),
        ],
      }),
    );
    expect(read(ctx, "read_more")).toEqual({
      kind: "failed",
      marker: "site-text-duplicate:read_more",
    });
  });

  it("a variant's overlay translates the text", () => {
    const data = fixtureData({
      lists: [list([text(LABEL, "breadcrumb_label", "Breadcrumb")])],
      pageVariants: new Map([[PAGE.about, { variant: "de", group: null }]]),
      overlays: new Map([
        [
          "de",
          {
            values: new Map([[`list/${SITE_TEXTS}/item/${LABEL}/text`, "Brotkrumen"]]),
            hidden: new Set<string>(),
          },
        ],
      ]),
    });
    expect(read(page(PAGE.about, data), "breadcrumb_label")).toEqual({
      kind: "text",
      text: "Brotkrumen",
    });
    expect(read(page(PAGE.home, data), "breadcrumb_label")).toEqual({
      kind: "text",
      text: "Breadcrumb",
    });
  });
});
