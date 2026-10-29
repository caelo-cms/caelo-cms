// SPDX-License-Identifier: MPL-2.0

/**
 * #1257 — paginated page lists (`docs/lists.md` §6 "Pagination"): the URL
 * shape of follow-up pages, the settings, the resolver's slice and pager,
 * the render passes, and that a cut list is never silent.
 */

import { describe, expect, it } from "bun:test";
import { moduleUpdateSchema } from "../content.js";
import { createSiteLinkIndex } from "../link-refs.js";
import type { PageUrlStyle } from "../seo.js";
import { renderTemplate, type TemplateField } from "../template-engine.js";
import { DEFAULT_LIST_TYPES } from "./default-types.js";
import { mergeListRenderDeps, renderEveryPage, renderFirstPage } from "./paginated-render.js";
import {
  collidesWithFollowUps,
  effectivePagination,
  pageCountOf,
  pagedPath,
  pagedUrl,
  parsePagedPath,
  splitPaginationValue,
} from "./pagination.js";
import type { ListPageRecord, ListRenderData } from "./render-data.js";
import {
  createListRenderContext,
  type ListFieldSpec,
  type ListPageContext,
  paginationMarkers,
} from "./resolve.js";
import type { ScopeEntry } from "./scope.js";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HUB = id(1);
const TAG = `caelo:term/${id(900)}/${id(901)}`;

/** A guides hub at /guides and `n` published guides titled "Guide 001"…. */
function site(n: number): { data: ListRenderData; paths: Map<string, string> } {
  const record = (pageId: string, title: string, extra: Partial<ListPageRecord> = {}) =>
    ({
      id: pageId,
      title,
      shortTitle: title,
      parentId: null,
      pageTypeSlug: "page",
      properties: {},
      terms: [],
      firstPublishedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      summary: null,
      image: null,
      inBuild: true,
      ...extra,
    }) satisfies ListPageRecord;
  const pages: ListPageRecord[] = [record(HUB, "Guides")];
  const paths = new Map<string, string>([[HUB, "/guides"]]);
  for (let i = 1; i <= n; i += 1) {
    const pid = id(100 + i);
    const title = `Guide ${String(i).padStart(3, "0")}`;
    pages.push(record(pid, title, { pageTypeSlug: "guide", terms: [TAG] }));
    paths.set(pid, `/guides/g${i}`);
  }
  return {
    paths,
    data: {
      listTypes: new Map(DEFAULT_LIST_TYPES.map((t, i) => [t.slug, { id: id(600 + i), def: t }])),
      lists: new Map(),
      pageTypes: new Map(),
      pages: new Map(pages.map((p) => [p.id, p])),
      media: new Map(),
      siteLanguage: "en",
      homePageId: null,
    },
  };
}

function ctxFor(
  n: number,
  opts: { page?: number; pageCount?: number; style?: PageUrlStyle } = {},
): ListPageContext {
  const { data, paths } = site(n);
  const style = opts.style ?? "directory";
  const index = createSiteLinkIndex({
    pages: [...paths].map(([pid, path]) => ({ id: pid, path, status: "published" as const })),
    media: [],
    env: "preview",
    pageUrlStyle: style,
  });
  return createListRenderContext(data).forPage(HUB, {
    linkResolver: index.forPage(HUB),
    pageUrlStyle: style,
    ...(opts.page !== undefined
      ? {
          pagination: { page: opts.page, ...(opts.pageCount ? { pageCount: opts.pageCount } : {}) },
        }
      : {}),
  });
}

const GUIDES: ListFieldSpec = {
  name: "guides",
  listType: "links",
  bind: "source",
  source: { kind: "query", editable: [], defaults: { page_type: "guide", order: "title_asc" } },
  paginate: {},
};
const PAGER: ListFieldSpec = {
  name: "pager",
  listType: "links",
  bind: "source",
  source: { kind: "system", name: "pagination" },
};

function resolve(ctx: ListPageContext, field: ListFieldSpec, value?: unknown): ScopeEntry[] {
  const r = ctx.resolveField(field, value, { contentInstanceId: null });
  if (!r.ok) throw new Error(r.marker);
  return [...r.entries];
}
const text = (e: ScopeEntry, key: string): string => {
  const v = e.get(key);
  if (v?.kind === "text") return v.text;
  if (v?.kind === "record") return v.text ?? "";
  if (v?.kind === "bool") return String(v.value);
  throw new Error(`${key}: ${v?.kind}`);
};

describe("follow-up URLs", () => {
  it("puts page n under the overview's path, never page 1", () => {
    expect(pagedPath("/guides", 2)).toBe("/guides/page/2");
    expect(pagedPath("/", 3)).toBe("/page/3");
    expect(() => pagedPath("/guides", 1)).toThrow();
  });

  it("follows the target's URL style and drops query and fragment", () => {
    expect(pagedUrl("/guides/", 2, "directory")).toBe("/guides/page/2/");
    expect(pagedUrl("/guides", 2, "no-extension")).toBe("/guides/page/2");
    expect(pagedUrl("https://example.com/", 4, "directory")).toBe("https://example.com/page/4/");
    expect(pagedUrl("/guides/?ref=nav#top", 2, "directory")).toBe("/guides/page/2/");
  });

  it("parses a requested follow-up path; /page/1 is no follow-up page", () => {
    expect(parsePagedPath("/guides/page/3/")).toEqual({ basePath: "/guides", page: 3 });
    expect(parsePagedPath("/page/2")).toEqual({ basePath: "/", page: 2 });
    expect(parsePagedPath("/guides/page/1")).toBeNull();
    expect(parsePagedPath("/guides/pages/2")).toBeNull();
    expect(parsePagedPath("/guides")).toBeNull();
  });

  it("detects a page sitting where follow-up pages go", () => {
    expect(collidesWithFollowUps("/guides", "/guides/page")).toBe(true);
    expect(collidesWithFollowUps("/guides", "/guides/page/2")).toBe(true);
    expect(collidesWithFollowUps("/", "/page")).toBe(true);
    expect(collidesWithFollowUps("/guides", "/guides/pager")).toBe(false);
    expect(collidesWithFollowUps("/guides", "/guides/g1")).toBe(false);
  });
});

describe("settings", () => {
  it("defaults to 50 per page, indexable; a placement overrides the field", () => {
    expect(effectivePagination({}, undefined)).toEqual({ perPage: 50, followUps: "index" });
    expect(effectivePagination({ per_page: 20 }, { follow_ups: "noindex" })).toEqual({
      perPage: 20,
      followUps: "noindex",
    });
    expect(effectivePagination({}, { per_page: 51 })).toBeNull();
  });

  it("splits the placement's paginate from the source's knobs", () => {
    expect(splitPaginationValue({ terms: ["x"], paginate: { per_page: 5 } })).toEqual({
      paginate: { per_page: 5 },
      rest: { terms: ["x"] },
    });
    expect(splitPaginationValue(undefined)).toEqual({ paginate: undefined, rest: undefined });
  });

  it("page count is at least one", () => {
    expect(pageCountOf(0, 50)).toBe(1);
    expect(pageCountOf(50, 50)).toBe(1);
    expect(pageCountOf(51, 50)).toBe(2);
  });
});

describe("module field schema", () => {
  const parseFields = (fields: unknown[]) =>
    moduleUpdateSchema.safeParse({ moduleId: id(9), fields });
  const field = (extra: Record<string, unknown>) => ({
    name: "guides",
    label: "Guides",
    kind: "list",
    listType: "links",
    bind: "source",
    source: { kind: "query", editable: [], defaults: { page_type: "guide", order: "title_asc" } },
    ...extra,
  });

  it("accepts a paginated query and term_pages", () => {
    expect(parseFields([field({ paginate: { per_page: 20 } })]).success).toBe(true);
    expect(
      parseFields([field({ source: { kind: "system", name: "term_pages" }, paginate: {} })])
        .success,
    ).toBe(true);
  });

  it("refuses paginate on a query with a limit, a stored list, or twice per module", () => {
    const withLimit = parseFields([
      field({
        source: {
          kind: "query",
          editable: [],
          defaults: { page_type: "guide", order: "title_asc", limit: 10 },
        },
        paginate: {},
      }),
    ]);
    expect(withLimit.success).toBe(false);
    expect(JSON.stringify(withLimit.error?.issues)).toContain("paginate.per_page");
    const local = parseFields([
      { name: "items", label: "Items", kind: "list", listType: "links", paginate: {} },
    ]);
    expect(local.success).toBe(false);
    const twice = parseFields([field({ paginate: {} }), field({ name: "more", paginate: {} })]);
    expect(JSON.stringify(twice.error?.issues)).toContain("only one paginated list field");
    expect(parseFields([field({ paginate: { per_page: 51 } })]).success).toBe(false);
  });
});

describe("resolver", () => {
  it("shows 50 per page by default and records the sequence", () => {
    const ctx = ctxFor(63);
    const page1 = resolve(ctx, GUIDES);
    expect(page1).toHaveLength(50);
    expect(text(page1[0] as ScopeEntry, "title")).toBe("Guide 001");
    expect(ctx.pagination()).toMatchObject({
      field: "guides",
      perPage: 50,
      total: 63,
      pageCount: 2,
      page: 1,
      followUps: "index",
    });
    expect(ctx.truncatedLists()).toEqual([]);
  });

  it("shows the requested page's slice with a custom page size", () => {
    const ctx = ctxFor(63, { page: 3, pageCount: 4 });
    const got = resolve(ctx, { ...GUIDES, paginate: { per_page: 20 } });
    expect(got.map((e) => text(e, "title"))).toEqual(
      Array.from({ length: 20 }, (_, i) => `Guide ${String(41 + i).padStart(3, "0")}`),
    );
    expect(ctx.pagination()?.pageCount).toBe(4);
  });

  it("takes the placement's paginate over the field's", () => {
    const ctx = ctxFor(63);
    resolve(ctx, GUIDES, { paginate: { per_page: 10, follow_ups: "noindex" } });
    expect(ctx.pagination()).toMatchObject({ perPage: 10, pageCount: 7, followUps: "noindex" });
  });

  it("paginates term_pages", () => {
    const ctx = ctxFor(55);
    const field: ListFieldSpec = {
      ...GUIDES,
      source: { kind: "system", name: "term_pages" },
      paginate: { per_page: 25 },
    };
    expect(resolve(ctx, field, { terms: [TAG] })).toHaveLength(25);
    expect(ctx.pagination()).toMatchObject({ total: 55, pageCount: 3 });
  });

  it("refuses a second, different paginated list on the page", () => {
    const ctx = ctxFor(10);
    resolve(ctx, GUIDES);
    const other = ctx.resolveField(
      { ...GUIDES, name: "more", paginate: { per_page: 3 } },
      undefined,
      { contentInstanceId: null },
    );
    expect(other).toEqual({ ok: false, marker: "list-pagination-conflict:more" });
    // The same list again (a second section over it) is fine.
    expect(resolve(ctx, GUIDES)).toHaveLength(10);
  });

  it("the pager links every page in the target's style and marks prev / current / next", () => {
    const ctx = ctxFor(63, { page: 2, pageCount: 3, style: "no-extension" });
    resolve(ctx, { ...GUIDES, paginate: { per_page: 25 } });
    const pager = resolve(ctx, PAGER);
    expect(pager.map((e) => text(e, "number"))).toEqual(["1", "2", "3"]);
    expect(pager.map((e) => text(e, "link"))).toEqual([
      "/guides",
      "/guides/page/2",
      "/guides/page/3",
    ]);
    expect(pager.map((e) => text(e, "is_prev"))).toEqual(["true", "false", "false"]);
    expect(pager.map((e) => text(e, "is_current"))).toEqual(["false", "true", "false"]);
    expect(pager.map((e) => text(e, "is_next"))).toEqual(["false", "false", "true"]);
    expect(ctx.pagination()?.pagerShown).toBe(true);
  });

  it("the pager is empty while everything fits on one page", () => {
    const ctx = ctxFor(5);
    resolve(ctx, GUIDES);
    expect(resolve(ctx, PAGER)).toEqual([]);
    expect(paginationMarkers(ctx.pagination())).toEqual([]);
  });

  it("a pager before the list asks for a second pass", () => {
    const ctx = ctxFor(63);
    expect(resolve(ctx, PAGER)).toEqual([]);
    resolve(ctx, GUIDES);
    expect(ctx.pagination()).toMatchObject({ pagerEarly: true, pageCount: 2 });
  });

  it("a paginated page without a pager is flagged", () => {
    const ctx = ctxFor(63);
    resolve(ctx, GUIDES);
    expect(paginationMarkers(ctx.pagination())).toEqual(["list-pager-missing:guides"]);
  });

  it("a pager without the target's URL style is loud", () => {
    const { data, paths } = site(63);
    const index = createSiteLinkIndex({
      pages: [...paths].map(([pid, path]) => ({ id: pid, path, status: "published" as const })),
      media: [],
      env: "preview",
      pageUrlStyle: "directory",
    });
    const ctx = createListRenderContext(data).forPage(HUB, { linkResolver: index.forPage(HUB) });
    resolve(ctx, GUIDES);
    expect(ctx.resolveField(PAGER, undefined, { contentInstanceId: null })).toEqual({
      ok: false,
      marker: "list-context-unavailable:pagination",
    });
  });
});

describe("cut lists are reported, never silent", () => {
  it("records a query cut at its limit", () => {
    const ctx = ctxFor(63);
    const q: ListFieldSpec = {
      ...GUIDES,
      paginate: undefined,
      source: {
        kind: "query",
        editable: [],
        defaults: { page_type: "guide", order: "title_asc", limit: 50 },
      },
    };
    expect(resolve(ctx, q)).toHaveLength(50);
    expect(ctx.truncatedLists()).toEqual([{ field: "guides", shown: 50, total: 63, limit: 50 }]);
    expect(ctx.pagination()).toBeNull();
  });

  it("records term_pages cut at 50", () => {
    const ctx = ctxFor(60);
    const field: ListFieldSpec = {
      name: "tagged",
      listType: "links",
      bind: "source",
      source: { kind: "system", name: "term_pages" },
    };
    expect(resolve(ctx, field, { terms: [TAG] })).toHaveLength(50);
    expect(ctx.truncatedLists()).toEqual([{ field: "tagged", shown: 50, total: 60, limit: 50 }]);
  });

  it("records nothing when everything fits", () => {
    const ctx = ctxFor(3);
    resolve(ctx, {
      ...GUIDES,
      paginate: undefined,
      source: {
        kind: "query",
        editable: [],
        defaults: { page_type: "guide", order: "title_asc", limit: 5 },
      },
    });
    expect(ctx.truncatedLists()).toEqual([]);
  });
});

describe("render passes (engine)", () => {
  const fields: TemplateField[] = [
    { name: "pager", kind: "list", listType: "links", bind: "source", source: PAGER.source },
    {
      name: "guides",
      kind: "list",
      listType: "links",
      bind: "source",
      source: GUIDES.source,
      paginate: { per_page: 30 },
    },
  ];
  // The pager ABOVE the list: page 1 needs the second pass.
  const html =
    '<nav>{{#pager}}{{#is_current}}<b>{{number}}</b>{{/is_current}}{{^is_current}}<a href="{{link}}">{{number}}</a>{{/is_current}}{{/pager}}</nav>' +
    "<ul>{{#guides}}<li>{{title}}</li>{{/guides}}</ul>";
  const render = (pagination?: { page: number; pageCount: number }) => {
    const ctx = ctxFor(63, pagination ?? {});
    const out = renderTemplate({ html, fields, lists: ctx });
    return { lists: ctx, html: out.html, missing: out.missingSlots };
  };

  it("renders page 1 twice when the pager comes first, with a complete pager", () => {
    const first = renderFirstPage(render);
    expect(first.missing).toEqual([]);
    expect(first.html).toContain(
      '<b>1</b><a href="/guides/page/2/">2</a><a href="/guides/page/3/">3</a>',
    );
    expect((first.html.match(/<li>/g) ?? []).length).toBe(30);
  });

  it("renders every page of the sequence with its slice", () => {
    const pages = renderEveryPage(render);
    expect(pages).toHaveLength(3);
    expect(pages[2]?.html).toContain('<a href="/guides/">1</a>');
    expect(pages[2]?.html).toContain("<b>3</b>");
    expect((pages[2]?.html.match(/<li>/g) ?? []).length).toBe(3);
    expect(pages[2]?.html).toContain("<li>Guide 063</li>");
    const deps = mergeListRenderDeps(pages.map((p) => p.lists.deps()));
    expect(deps.queries).toEqual([{ pageType: "guide", terms: [], parent: null }]);
  });
});
