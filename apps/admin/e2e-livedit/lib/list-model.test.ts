// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  blogCategoryFacts,
  calledTool,
  type ListModelSnapshot,
  megaMenuFacts,
} from "./list-model.js";

const MENU_TYPE = "11111111-1111-1111-1111-111111111111";
const MENU = "22222222-2222-2222-2222-222222222222";
const VOCAB_TYPE = "33333333-3333-3333-3333-333333333333";
const VOCAB = "44444444-4444-4444-4444-444444444444";
const HOME_PT = "55555555-5555-5555-5555-555555555555";
const ARTICLE_PT = "66666666-6666-6666-6666-666666666666";

function base(over: Partial<ListModelSnapshot> = {}): ListModelSnapshot {
  return {
    listTypes: [],
    lists: [],
    pageTypes: [],
    pages: [],
    modules: [],
    chrome: [],
    instanceValues: [],
    homePageTypeId: HOME_PT,
    toolText: "",
    lastAssistant: "",
    ...over,
  };
}

const column = (label: string) => ({
  node: "column",
  values: { heading: label },
  children: [{ node: "link", values: { label: `${label} link`, link: { href: "/" } } }],
});

const megaSnap = (headerBind: "shared" | "local") =>
  base({
    listTypes: [
      {
        id: MENU_TYPE,
        slug: "mega-menu",
        def: {
          slug: "mega-menu",
          role: "navigation",
          nodes: {
            column: { children: { name: "links", allow: ["link"] } },
            link: { fields: [{ name: "label", type: "text" }] },
            news: { source: { kind: "query", defaults: { page_type: "news" } } },
          },
        },
      },
    ],
    lists: [
      {
        id: MENU,
        slug: "main-menu",
        listTypeId: MENU_TYPE,
        items: [column("Products"), column("Solutions"), column("Company"), { node: "news" }],
      },
    ],
    modules: [
      {
        id: "h",
        html: "",
        fields: [
          {
            name: "menu",
            kind: "list",
            listType: "mega-menu",
            bind: headerBind,
            ...(headerBind === "shared" ? { list: `caelo:list/${MENU}` } : {}),
          },
        ],
      },
      { id: "f", html: "", fields: [{ name: "menu", kind: "list", bind: "shared" }] },
    ],
    chrome: [
      { blockName: "header", moduleId: "h" },
      { blockName: "footer", moduleId: "f" },
    ],
    // The footer binds through its placement value, not a fixed list.
    instanceValues: [{ moduleId: "f", values: { menu: `caelo:list/${MENU}` } }],
  });

describe("megaMenuFacts", () => {
  it("finds the shared list header and footer both show, its columns and its news node", () => {
    const f = megaMenuFacts(megaSnap("shared"));
    expect(f.listId).toBe(MENU);
    expect(f.columnCount).toBe(3);
    expect(f.typeHasQueryNode).toBe(true);
    expect(f.listHasQueryEntry).toBe(true);
    expect(f.text).toContain("company");
  });

  it("counts columns nested under one trigger entry, not the trigger itself", () => {
    const snap = megaSnap("shared");
    const list = snap.lists[0];
    if (!list) throw new Error("fixture has no list");
    const nested = {
      ...snap,
      lists: [
        {
          ...list,
          items: [
            {
              node: "column",
              values: { heading: "Menu" },
              children: [
                column("Products"),
                column("Solutions"),
                column("Company"),
                { node: "news" },
              ],
            },
          ],
        },
      ],
    };
    expect(megaMenuFacts(nested).columnCount).toBe(3);
  });

  it("a local header list is no shared menu", () => {
    expect(megaMenuFacts(megaSnap("local")).listId).toBeNull();
  });
});

describe("blogCategoryFacts", () => {
  const cat = (id: string, name: string) => ({
    id,
    node: "category",
    values: { name, slug: name },
  });
  const snap = base({
    listTypes: [
      {
        id: VOCAB_TYPE,
        slug: "categories",
        def: { slug: "categories", role: "vocabulary", nodes: { category: {} } },
      },
    ],
    lists: [
      {
        id: VOCAB,
        slug: "blog-categories",
        listTypeId: VOCAB_TYPE,
        items: [cat("a", "Guides"), cat("b", "Product news"), cat("c", "Engineering")],
      },
    ],
    pageTypes: [
      { id: HOME_PT, slug: "page", def: { vocabularies: [{ list: VOCAB }] } },
      { id: ARTICLE_PT, slug: "article", def: { vocabularies: [{ list: VOCAB }] } },
    ],
    pages: [
      { id: "1", slug: "a", title: "A", pageTypeId: ARTICLE_PT, terms: [`caelo:term/${VOCAB}/a`] },
      { id: "2", slug: "b", title: "B", pageTypeId: ARTICLE_PT, terms: [`caelo:term/${VOCAB}/b`] },
      { id: "3", slug: "c", title: "C", pageTypeId: ARTICLE_PT, terms: [`caelo:term/${VOCAB}/c`] },
      // A home-typed page with a term is no article.
      { id: "4", slug: "d", title: "D", pageTypeId: HOME_PT, terms: [`caelo:term/${VOCAB}/a`] },
    ],
    modules: [
      {
        id: "landing",
        html: "",
        fields: [
          {
            name: "articles",
            kind: "list",
            bind: "source",
            source: { kind: "system", name: "term_pages" },
          },
        ],
      },
    ],
  });

  it("reads the vocabulary, the article type, the tagged articles and the landing listing", () => {
    const f = blogCategoryFacts(snap, ["guides", "product news", "engineering"]);
    expect(f.vocabularyId).toBe(VOCAB);
    expect(f.articleTypeIds).toEqual([ARTICLE_PT]);
    expect(f.taggedArticles).toBe(3);
    expect(f.coveredCategories).toBe(3);
    expect(f.termListingModules).toBe(1);
  });

  it("without a vocabulary carrying the names nothing counts", () => {
    expect(blogCategoryFacts(snap, ["recipes"]).vocabularyId).toBeNull();
  });
});

describe("calledTool", () => {
  it("matches the quoted tool name only", () => {
    const snap = base({ toolText: '[{"toolName":"patch_list_items_many"}]' });
    expect(calledTool(snap, "patch_list_items_many")).toBe(true);
    expect(calledTool(snap, "patch_list_items")).toBe(false);
  });
});
