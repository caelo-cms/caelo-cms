// SPDX-License-Identifier: MPL-2.0

/**
 * The list resolver (epic #1107, `docs/lists.md` §6, §9, §10): every
 * source kind, query knobs, variant scoping, overlays (replace, hide,
 * refused changes) and the render dependencies a page records.
 */

import { describe, expect, it } from "bun:test";
import type { LinkPageVariant } from "../link-refs.js";
import { fixtureData, fixtureLinkIndex, ITEM, LIST, PAGE, TERM } from "./list-fixtures.test.js";
import type { QueryKnob } from "./list-type.js";
import type { ListVariantOverlay } from "./render-data.js";
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

  it("breadcrumbs run root → current", () => {
    expect(entries(page(PAGE.team), sys("breadcrumbs")).map((e) => textOf(e, "title"))).toEqual([
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
