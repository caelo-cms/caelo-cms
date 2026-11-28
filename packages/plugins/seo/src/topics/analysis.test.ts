// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  linkGraph,
  linkSuggestions,
  nearDuplicates,
  termCounts,
  termKey,
  termUse,
} from "./analysis.js";
import type { PageIndexRow } from "./page-index.js";

/** A blog of seven articles, a home page and a topic page. */
function row(
  id: string,
  terms: string[],
  links: string[] = [],
  extra: Partial<PageIndexRow> = {},
): PageIndexRow {
  return {
    id: `row-${id}`,
    page_id: id,
    path: `/${id}`,
    title: id.toUpperCase(),
    page_type: "article",
    terms: { tags: terms },
    links,
    indexable: true,
    ...extra,
  };
}

const rows: PageIndexRow[] = [
  row("home", [], ["a1", "topic"], { page_type: "home", path: "/" }),
  row("topic", [], ["a1", "a2", "a3"], { page_type: "topic" }),
  row("a1", ["seo", "jsonld"], ["a2"]),
  row("a2", ["seo"], []),
  row("a3", ["seo", "seo-tools"], []),
  row("a4", ["seo", "seo-tool"], []),
  row("a5", ["seo"], []),
  row("a6", ["jsonld"], []),
  row("a7", ["seo"], [], { indexable: false }),
];

const terms = [
  { itemId: "seo", name: "SEO", topicPage: null, topicPageId: null },
  { itemId: "jsonld", name: "JSON-LD", topicPage: "/topics/json-ld", topicPageId: null },
  { itemId: "seo-tools", name: "SEO Tools", topicPage: null, topicPageId: null },
  { itemId: "seo-tool", name: "SEO-Tool", topicPage: null, topicPageId: null },
];

describe("topic terms (#1759)", () => {
  it("suggests a topic page for a term on at least the threshold of published pages", () => {
    const use = termUse(terms, termCounts(rows, "tags"), 5);
    expect(use.map((t) => [t.name, t.pages, t.suggestTopicPage])).toEqual([
      // a7 is noindex: not counted.
      ["SEO", 5, true],
      ["JSON-LD", 2, false],
      ["SEO Tools", 1, false],
      ["SEO-Tool", 1, false],
    ]);
  });

  it("finds one topic spelt twice and keeps the term with the topic page or the most pages", () => {
    expect(termKey("SEO-Tools")).toBe(termKey("seo tool"));
    const groups = nearDuplicates(termUse(terms, termCounts(rows, "tags"), 5));
    expect(groups.map((g) => [g.terms.map((t) => t.name), g.into.name, g.reason])).toEqual([
      [
        ["SEO Tools", "SEO-Tool"],
        "SEO Tools",
        "the same name apart from case, accents, hyphens or a plural",
      ],
    ]);
    expect(
      nearDuplicates(
        termUse(
          [
            { itemId: "x", name: "Crawling", topicPage: "/topics/crawling", topicPageId: null },
            { itemId: "y", name: "Crawlling", topicPage: null, topicPageId: null },
            { itemId: "z", name: "Ads", topicPage: null, topicPageId: null },
          ],
          new Map(),
          5,
        ),
      ).map((g) => [g.into.name, g.reason]),
    ).toEqual([["Crawling", "the names are one letter apart"]]);
  });
});

describe("internal links (#1759)", () => {
  const graph = linkGraph(rows, "home");

  it("counts inbound content links and click depth from the home page", () => {
    expect(graph.inbound.get("a1")).toBe(2);
    expect(graph.inbound.get("a2")).toBe(2);
    expect(graph.inbound.get("a5")).toBeUndefined();
    expect(graph.depth.get("home")).toBe(0);
    expect(graph.depth.get("a1")).toBe(1);
    expect(graph.depth.get("a3")).toBe(2);
    expect(graph.depth.get("a5")).toBeUndefined();
  });

  it("suggests pages with shared terms, names the reasons and skips pages already linked", () => {
    const a1 = rows.find((r) => r.page_id === "a1") as PageIndexRow;
    const names: Record<string, string> = { seo: "SEO", jsonld: "JSON-LD" };
    const suggestions = linkSuggestions(rows, a1, graph, (_v, id) => names[id] ?? null);
    expect(suggestions.map((s) => s.pageId)).not.toContain("a2");
    expect(suggestions.map((s) => s.pageId)).not.toContain("a7");
    expect(suggestions[0]).toEqual({
      pageId: "a3",
      path: "/a3",
      title: "A3",
      reasons: ["shares the terms SEO", "same page type (article)", "only one page links to it"],
    });
    expect(suggestions.find((s) => s.pageId === "a6")?.reasons).toEqual([
      "shares the terms JSON-LD",
      "same page type (article)",
      "no page links to it yet",
    ]);
  });
});
