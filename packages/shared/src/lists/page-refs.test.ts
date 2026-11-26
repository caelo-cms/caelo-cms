// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1754 — page references (`docs/lists.md` §2, §6, §10): the `page`
 * field type, the `refers_to` page query, the render dependencies that
 * rebuild an author page when an article names it, and a term's overview
 * page in term chips and breadcrumbs.
 *
 * The site: Home; a Team section with two author pages (Anna, Ben) and a
 * draft one (Cleo); a Blog with three articles naming them; a Topics
 * section with an overview page for the "SEO" category, whose child
 * category "Technical" has none.
 */

import { describe, expect, it } from "bun:test";
import { createSiteLinkIndex, type LinkPageVariant } from "../link-refs.js";
import { renderTemplate } from "../template-engine.js";
import { DEFAULT_LIST_TYPES } from "./default-types.js";
import { type FieldDef, validateFieldValue } from "./fields.js";
import type { ListItem } from "./items.js";
import { checkListTypeDef, type ListTypeDef } from "./list-type.js";
import { pageListOverlayScope } from "./overlay-scope.js";
import { pageRefsOfProperties } from "./page-refs.js";
import type { PageTypeDef } from "./page-type.js";
import type { ListPageRecord, ListRenderData, ListRenderDeps } from "./render-data.js";
import { mergeRenderDeps, renderDepsAttrs, selectDependentPages } from "./render-deps.js";
import { createListRenderContext, type ListFieldSpec, type ListPageContext } from "./resolve.js";
import type { ScopeEntry } from "./scope.js";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (pageId: string): string => `caelo:page/${pageId}`;

const P = {
  home: id(1),
  team: id(2),
  anna: id(3),
  ben: id(4),
  cleo: id(5),
  blog: id(6),
  post1: id(7),
  post2: id(8),
  post3: id(9),
  topics: id(10),
  seo: id(11),
  // A German version of Anna and of post 1 (international-site partition).
  annaDe: id(12),
  post1De: id(13),
} as const;
const TOPICS_LIST = id(101);
const T = { seo: id(201), technical: id(202), plain: id(203) } as const;
const term = (item: string): string => `caelo:term/${TOPICS_LIST}/${item}`;

const AUTHORS: FieldDef = {
  name: "authors",
  label: "Authors",
  type: "page",
  pageType: "author",
  multiple: true,
};
const REVIEWER: FieldDef = { name: "reviewed_by", label: "Reviewed by", type: "page" };

const pageType = (slug: string, properties: FieldDef[]): PageTypeDef => ({
  slug,
  name: slug,
  purpose: `${slug} pages`,
  collection: true,
  templates: [id(801)],
  defaultTemplate: id(801),
  properties,
  vocabularies: [],
});

const page = (pageId: string, title: string, extra: Partial<ListPageRecord> = {}) =>
  ({
    id: pageId,
    title,
    shortTitle: title,
    parentId: null,
    pageTypeSlug: "page",
    properties: {},
    terms: [],
    firstPublishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary: null,
    image: null,
    inBuild: true,
    ...extra,
  }) satisfies ListPageRecord;

const PAGES: ListPageRecord[] = [
  page(P.home, "Home"),
  page(P.team, "Team"),
  page(P.anna, "Anna", {
    parentId: P.team,
    pageTypeSlug: "author",
    properties: { role: "Editor" },
  }),
  page(P.ben, "Ben", { parentId: P.team, pageTypeSlug: "author", properties: { role: "Writer" } }),
  page(P.cleo, "Cleo", { parentId: P.team, pageTypeSlug: "author", inBuild: false }),
  page(P.blog, "Blog"),
  page(P.post1, "Post one", {
    parentId: P.blog,
    pageTypeSlug: "article",
    firstPublishedAt: "2026-03-01T00:00:00.000Z",
    // Ben first: the order is the article's, not the title order.
    properties: { authors: [ref(P.ben), ref(P.anna)], reviewed_by: [ref(P.cleo)] },
    terms: [term(T.technical)],
  }),
  page(P.post2, "Post two", {
    parentId: P.blog,
    pageTypeSlug: "article",
    firstPublishedAt: "2026-04-01T00:00:00.000Z",
    properties: { authors: [ref(P.anna), ref(P.cleo)] },
    terms: [term(T.plain), term(T.seo)],
  }),
  page(P.post3, "Post three", {
    parentId: P.blog,
    pageTypeSlug: "article",
    firstPublishedAt: "2026-05-01T00:00:00.000Z",
    properties: { authors: [ref(P.ben)] },
  }),
  page(P.topics, "Topics"),
  page(P.seo, "SEO", { parentId: P.topics }),
];

const TOPICS_ITEMS: ListItem[] = [
  {
    id: T.seo,
    node: "category",
    values: { name: "SEO", slug: "seo", landing_page: { href: ref(P.seo) } },
    children: [{ id: T.technical, node: "category", values: { name: "Technical", slug: "tech" } }],
  },
  { id: T.plain, node: "category", values: { name: "Plain", slug: "plain" } },
];

function data(
  extra: { pages?: ListPageRecord[]; pageVariants?: Map<string, LinkPageVariant> } = {},
) {
  const types = DEFAULT_LIST_TYPES;
  return {
    listTypes: new Map(types.map((t, i) => [t.slug, { id: id(600 + i), def: t }])),
    lists: new Map([
      [
        TOPICS_LIST,
        {
          id: TOPICS_LIST,
          slug: "topics",
          name: "Topics",
          typeSlug: "categories",
          items: TOPICS_ITEMS,
        },
      ],
    ]),
    pageTypes: new Map([
      [
        "author",
        { id: id(701), def: pageType("author", [{ name: "role", label: "Role", type: "text" }]) },
      ],
      ["article", { id: id(702), def: pageType("article", [AUTHORS, REVIEWER]) }],
    ]),
    pages: new Map((extra.pages ?? PAGES).map((p) => [p.id, p])),
    media: new Map(),
    ...(extra.pageVariants ? { pageVariants: extra.pageVariants } : {}),
    siteLanguage: "en",
    homePageId: P.home,
  } satisfies ListRenderData;
}

const PATHS: Record<string, string> = {
  [P.home]: "/",
  [P.team]: "/team",
  [P.anna]: "/team/anna",
  [P.ben]: "/team/ben",
  [P.cleo]: "/team/cleo",
  [P.blog]: "/blog",
  [P.post1]: "/blog/one",
  [P.post2]: "/blog/two",
  [P.post3]: "/blog/three",
  [P.topics]: "/topics",
  [P.seo]: "/topics/seo",
  [P.annaDe]: "/de/team/anna",
  [P.post1De]: "/de/blog/eins",
};

function linksOf(d: ListRenderData) {
  return createSiteLinkIndex({
    pages: [...d.pages.values()].map((p) => ({
      id: p.id,
      path: PATHS[p.id] ?? "/",
      status: p.inBuild ? "published" : "draft",
    })),
    media: [],
    env: "preview",
    pageUrlStyle: "directory",
    ...(d.pageVariants ? { pageVariants: d.pageVariants } : {}),
  });
}

function ctxFor(pageId: string | null, d: ListRenderData = data()): ListPageContext {
  return createListRenderContext(d).forPage(pageId, { linkResolver: linksOf(d).forPage(pageId) });
}

/** Render `html` on page `pageId` as the composer does (lists + link resolver). */
function renderOn(html: string, pageId: string, d: ListRenderData = data()) {
  const lists = ctxFor(pageId, d);
  const r = renderTemplate({
    html,
    fields: [],
    contentValues: {},
    lists,
    linkResolver: linksOf(d).forPage(pageId),
  });
  return { ...r, html: r.html.replace(/ data-caelo-list-item="[^"]*"/g, ""), lists };
}

const titles = (entries: readonly ScopeEntry[]): string[] =>
  entries.map((e) => {
    const v = e.get("title");
    return v?.kind === "text" ? v.text : "";
  });

function resolve(ctx: ListPageContext, field: ListFieldSpec, value?: unknown) {
  const r = ctx.resolveField(field, value, { contentInstanceId: null });
  if (!r.ok) throw new Error(`${r.marker} ${r.detail ?? ""}`);
  return r.entries;
}

const ARTICLES_OF_SELF: ListFieldSpec = {
  name: "articles",
  listType: "links",
  bind: "source",
  source: {
    kind: "query",
    editable: [],
    defaults: {
      page_type: "article",
      refers_to: { property: "authors", page: "self" },
      order: "published_desc",
      limit: 10,
    },
  },
};

describe("the page field type", () => {
  it("takes an ordered array of page references, each once", () => {
    expect(validateFieldValue(AUTHORS, [ref(P.ben), ref(P.anna)], "authors")).toEqual([]);
    expect(validateFieldValue(AUTHORS, [ref(P.ben), ref(P.ben)], "authors")[0]?.message).toContain(
      "each page once",
    );
    expect(validateFieldValue(AUTHORS, ["/team/anna"], "authors")[0]?.message).toContain(
      "an array of pages, in order",
    );
    expect(validateFieldValue(REVIEWER, [ref(P.ben), ref(P.anna)], "r")[0]?.message).toContain(
      "at most one page",
    );
    expect(
      validateFieldValue({ ...REVIEWER, required: true }, [], "reviewed_by")[0]?.message,
    ).toContain("at least one page");
  });

  it("is a page property only — a list type refuses it", () => {
    const def: ListTypeDef = {
      slug: "people",
      name: "People",
      purpose: "x",
      role: "content",
      root: { allow: ["person"] },
      nodes: { person: { label: "Person", fields: [{ name: "who", label: "Who", type: "page" }] } },
    };
    expect(checkListTypeDef(def).map((i) => i.message)).toEqual([
      'a "page" field is a page-type property (page_types.upsert_many) — a list entry points at a page with a link field.',
    ]);
  });

  it("finds the references of every page property, and nothing else", () => {
    expect(
      pageRefsOfProperties({
        authors: [ref(P.ben), ref(P.anna)],
        tags: [`caelo:term/${TOPICS_LIST}/${T.seo}`],
        cta: { href: ref(P.home) },
        mixed: [ref(P.ben), "/x"],
      }),
    ).toEqual(new Map([["authors", [P.ben, P.anna]]]));
  });
});

describe("rendering a page property's pages", () => {
  const html =
    '{{#page.props.authors}}<a href="{{link}}">{{title}} ({{props.role}})</a>{{/page.props.authors}}';

  it("shows the pages in the article's order, with their own properties", () => {
    const r = renderOn(html, P.post1);
    expect(r.missingSlots).toEqual([]);
    expect(r.html).toBe(
      '<a href="/team/ben/">Ben (Writer)</a><a href="/team/anna/">Anna (Editor)</a>',
    );
    // Editing Ben's or Anna's page rebuilds the article.
    expect(r.lists.deps().pages).toEqual(expect.arrayContaining([P.ben, P.anna]));
  });

  it("leaves out a page this build does not ship (a draft author)", () => {
    const r = renderOn("{{#page.props.authors}}{{title}};{{/page.props.authors}}", P.post2);
    expect(r.html).toBe("Anna;");
  });

  it("names a referenced page that is gone, loudly", () => {
    const gone = id(999);
    const pages = PAGES.map((p) =>
      p.id === P.post3 ? { ...p, properties: { authors: [ref(gone)] } } : p,
    );
    const r = renderOn(
      "{{#page.props.authors}}{{title}}{{/page.props.authors}}",
      P.post3,
      data({ pages }),
    );
    expect(r.missingSlots).toContain(`list-missing:page/${gone}`);
  });

  it("an empty page property reads as absent", () => {
    const r = renderOn(
      "{{#page.props.reviewed_by}}by {{title}}{{/page.props.reviewed_by}}{{^page.props.reviewed_by}}unreviewed{{/page.props.reviewed_by}}",
      P.post3,
    );
    expect(r.html).toBe("unreviewed");
  });
});

describe("refers_to: pages naming a page", () => {
  it("an author page lists the articles naming it, in the query's order", () => {
    expect(titles(resolve(ctxFor(P.anna), ARTICLES_OF_SELF))).toEqual(["Post two", "Post one"]);
    expect(titles(resolve(ctxFor(P.ben), ARTICLES_OF_SELF))).toEqual(["Post three", "Post one"]);
  });

  it("a fixed page works on any page, and other filters still apply", () => {
    const fixed: ListFieldSpec = {
      ...ARTICLES_OF_SELF,
      source: {
        kind: "query",
        editable: ["refers_to"],
        defaults: { order: "title_asc", limit: 10 },
      },
    };
    const got = resolve(ctxFor(P.home), fixed, {
      refers_to: { property: "reviewed_by", page: ref(P.cleo) },
    });
    expect(titles(got)).toEqual(["Post one"]);
  });

  it("paginates like any other query", () => {
    const paged: ListFieldSpec = {
      name: "articles",
      listType: "links",
      bind: "source",
      source: {
        kind: "query",
        editable: [],
        defaults: { refers_to: { property: "authors", page: "self" }, order: "published_desc" },
      },
      paginate: { per_page: 1 },
    };
    const ctx = ctxFor(P.anna);
    expect(titles(resolve(ctx, paged))).toEqual(["Post two"]);
    expect(ctx.pagination()).toMatchObject({ total: 2, pageCount: 2, perPage: 1 });
    const second = createListRenderContext(data()).forPage(P.anna, { pagination: { page: 2 } });
    expect(titles(resolve(second, paged))).toEqual(["Post one"]);
  });

  it("refuses a property no page type declares as a page property, with the fix", () => {
    const typo: ListFieldSpec = {
      ...ARTICLES_OF_SELF,
      source: {
        kind: "query",
        editable: [],
        defaults: { refers_to: { property: "author", page: "self" }, order: "title_asc", limit: 5 },
      },
    };
    const r = ctxFor(P.anna).resolveField(typo, undefined, { contentInstanceId: null });
    expect(r).toMatchObject({
      ok: false,
      marker: "list-malformed:articles[query.refers_to.property]",
    });
    expect(r.ok ? "" : r.detail).toContain('no page type has a page property "author"');
  });

  it("records the reference as a render dependency", () => {
    const ctx = ctxFor(P.anna);
    resolve(ctx, ARTICLES_OF_SELF);
    expect(ctx.deps().queries).toEqual([
      {
        pageType: "article",
        terms: [],
        parent: null,
        refersTo: { property: "authors", pages: [P.anna] },
      },
    ]);
  });
});

describe("incremental builds", () => {
  const NONE: ListRenderDeps = {
    lists: [],
    listTypes: [],
    queries: [],
    pageTree: false,
    pages: [],
  };
  const authorDeps = (pageId: string): ListRenderDeps => {
    const ctx = ctxFor(pageId);
    resolve(ctx, ARTICLES_OF_SELF);
    return { ...NONE, queries: ctx.deps().queries };
  };
  const file = mergeRenderDeps(
    null,
    new Map([
      [P.anna, authorDeps(P.anna)],
      [P.ben, authorDeps(P.ben)],
      [P.post1, NONE],
    ]),
    PAGES,
  );
  const now = (pages: ListPageRecord[]) => new Map(pages.map((p) => [p.id, renderDepsAttrs(p)]));

  it("a new article naming an author rebuilds that author's page", () => {
    const post4 = page(id(14), "Post four", {
      pageTypeSlug: "article",
      properties: { authors: [ref(P.ben)] },
    });
    const got = selectDependentPages(
      file,
      { pageIds: [post4.id], listIds: [], listTypeSlugs: [] },
      now([...PAGES, post4]),
    );
    expect([...got]).toEqual([P.ben]);
  });

  it("an article that stops naming an author rebuilds that author's page too", () => {
    const pages = PAGES.map((p) =>
      p.id === P.post1 ? { ...p, properties: { authors: [ref(P.ben)] } } : p,
    );
    const got = selectDependentPages(
      file,
      { pageIds: [P.post1], listIds: [], listTypeSlugs: [] },
      now(pages),
    );
    expect([...got].sort()).toEqual([P.anna, P.ben].sort());
  });
});

describe("a term's overview page", () => {
  const CHIPS = '{{#page.terms.topics}}<a href="{{link}}">{{name}}</a>{{/page.terms.topics}}';
  const CRUMBS: ListFieldSpec = {
    name: "crumbs",
    listType: "links",
    bind: "source",
    source: { kind: "system", name: "breadcrumbs" },
    list: `caelo:list/${TOPICS_LIST}`,
  };

  it("every shipped vocabulary type names it", () => {
    for (const t of DEFAULT_LIST_TYPES.filter((x) => x.role === "vocabulary")) {
      expect(checkListTypeDef(t)).toEqual([]);
      const node = t.nodes[t.root.allow[0] as string];
      expect(node?.fields.find((f) => f.name === "landing_page")?.type).toBe("link");
    }
    const noOverview: ListTypeDef = {
      slug: "labels",
      name: "Labels",
      purpose: "x",
      role: "vocabulary",
      root: { allow: ["label"] },
      nodes: {
        label: {
          label: "Label",
          fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "slug", label: "Slug", type: "text" },
          ],
        },
      },
    };
    expect(checkListTypeDef(noOverview)[0]?.message).toContain('a link field "landing_page"');
  });

  it("term chips link there", () => {
    expect(renderOn(CHIPS, P.post2).html).toBe(
      '<a href="">Plain</a><a href="/topics/seo/">SEO</a>',
    );
  });

  it("breadcrumbs given the vocabulary lead through it — the entry's own, else its parent's", () => {
    const ctx = ctxFor(P.post2);
    expect(titles(resolve(ctx, CRUMBS))).toEqual(["Home", "Topics", "SEO", "Post two"]);
    expect(ctx.breadcrumbTrail()).toEqual([P.home, P.topics, P.seo, P.post2]);
    // "Technical" has no overview page; its parent "SEO" has.
    expect(titles(resolve(ctxFor(P.post1), CRUMBS))).toEqual(["Home", "Topics", "SEO", "Post one"]);
    // A change of the vocabulary (a new overview page) rebuilds the page.
    expect(ctx.deps().lists).toContain(TOPICS_LIST);
  });

  it("without a vocabulary, or a term that leads nowhere, the page tree decides", () => {
    const { list: _vocabulary, ...plain } = CRUMBS;
    expect(titles(resolve(ctxFor(P.post2), plain))).toEqual(["Home", "Blog", "Post two"]);
    expect(titles(resolve(ctxFor(P.post3), CRUMBS))).toEqual(["Home", "Blog", "Post three"]);
  });

  it("a page already below the overview page keeps its tree trail", () => {
    const pages = PAGES.map((p) => (p.id === P.post2 ? { ...p, parentId: P.seo } : p));
    expect(titles(resolve(ctxFor(P.post2, data({ pages })), CRUMBS))).toEqual([
      "Home",
      "Topics",
      "SEO",
      "Post two",
    ]);
  });

  it("an overview page this build does not ship is no crumb", () => {
    const pages = PAGES.map((p) => (p.id === P.seo ? { ...p, inBuild: false } : p));
    expect(titles(resolve(ctxFor(P.post2, data({ pages })), CRUMBS))).toEqual([
      "Home",
      "Blog",
      "Post two",
    ]);
  });
});

describe("language versions", () => {
  // Anna and post 1 have German versions; the German post names the
  // English Anna (a translated copy keeps the original's references).
  const pages = [
    ...PAGES,
    page(P.annaDe, "Anna (de)", { pageTypeSlug: "author", properties: { role: "Redakteurin" } }),
    page(P.post1De, "Beitrag eins", {
      pageTypeSlug: "article",
      properties: { authors: [ref(P.anna)] },
    }),
  ];
  const pageVariants = new Map<string, LinkPageVariant>([
    ...PAGES.map((p) => [p.id, { variant: "en", group: null }] as const),
    [P.anna, { variant: "en", group: "anna" }],
    [P.annaDe, { variant: "de", group: "anna" }],
    [P.post1, { variant: "en", group: "post1" }],
    [P.post1De, { variant: "de", group: "post1" }],
  ]);
  const d = data({ pages, pageVariants });

  it("a referenced page shows in the rendering page's language", () => {
    const r = renderOn(
      "{{#page.props.authors}}{{title}} {{props.role}}{{/page.props.authors}}",
      P.post1De,
      d,
    );
    expect(r.html).toBe("Anna (de) Redakteurin");
  });

  it("the German author page lists the German articles naming any version of it", () => {
    expect(titles(resolve(ctxFor(P.annaDe, d), ARTICLES_OF_SELF))).toEqual(["Beitrag eins"]);
    expect(titles(resolve(ctxFor(P.anna, d), ARTICLES_OF_SELF))).toEqual(["Post two", "Post one"]);
  });

  it("the overlay scope holds the named pages' versions in the page's language", () => {
    const scope = pageListOverlayScope({
      pageId: P.post1De,
      data: d,
      modules: [{ fields: [], html: "{{#page.props.authors}}{{title}}{{/page.props.authors}}" }],
      markup: [],
      contentInstanceIds: [],
    });
    expect(scope?.pageIds).toEqual([P.annaDe, P.post1De].sort());
  });

  it("…and the pages those pages name, transitively, a cycle included", () => {
    // Anna names her employer (the German team page has a version), the
    // employer names Anna back.
    const team = id(20);
    const teamDe = id(21);
    const linked = [
      ...pages.map((p) =>
        p.id === P.anna || p.id === P.annaDe
          ? { ...p, properties: { ...p.properties, employer: [ref(team)] } }
          : p,
      ),
      page(team, "Team", { properties: { members: [ref(P.anna)] } }),
      page(teamDe, "Team (de)"),
    ];
    const variants = new Map([
      ...pageVariants,
      [team, { variant: "en", group: "team" }],
      [teamDe, { variant: "de", group: "team" }],
    ]);
    const scope = pageListOverlayScope({
      pageId: P.post1De,
      data: data({ pages: linked, pageVariants: variants }),
      modules: [
        {
          fields: [],
          html: "{{#page.props.authors}}{{#props.employer}}{{title}}{{/props.employer}}{{/page.props.authors}}",
        },
      ],
      markup: [],
      contentInstanceIds: [],
    });
    expect(scope?.pageIds).toEqual([P.annaDe, P.post1De, teamDe].sort());
  });
});

describe("a template reading page references", () => {
  it("names the page type of a path it cannot answer", () => {
    expect(renderOn("{{page.props.authors}}", P.post1).missingSlots).toEqual([
      "page-path-unknown:props.authors:page",
    ]);
  });
});
