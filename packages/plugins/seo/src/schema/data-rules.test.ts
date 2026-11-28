// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import { graphNodes, mainNode, pageDataFindings } from "./data-rules.js";
import type { SchemaMapping } from "./mapping.js";
import { SCHEMA_TYPES } from "./types.js";

const URL_ = "https://example.com";

function facts(
  path: string,
  graph: unknown[],
  over: Partial<PluginAuditPageFacts> = {},
): PluginAuditPageFacts {
  return {
    pageId: "00000000-0000-4000-8000-000000000001",
    path,
    lang: "en",
    title: "T",
    metaDescription: "D",
    canonical: null,
    robots: null,
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates: [],
    sitemapAlternates: null,
    links: [],
    texts: [],
    headings: [],
    images: [],
    jsonLd: [
      {
        kind: "parsed",
        data: { "@context": "https://schema.org", "@graph": graph },
        moduleId: null,
        listItem: null,
        pluginSlug: null,
      },
    ],
    socialMeta: [],
    truncated: false,
    truncatedFacts: [],
    ...over,
  } as unknown as PluginAuditPageFacts;
}

const heading = (text: string) => ({
  level: 1,
  text,
  moduleId: null,
  listItem: null,
  pluginSlug: null,
});

const blog: SchemaMapping = {
  pageType: "post",
  schemaType: "BlogPosting",
  roles: { authors: "prop:author" },
};
const person: SchemaMapping = { pageType: "author", schemaType: "ProfilePage", roles: {} };
const overview: SchemaMapping = { pageType: "topic", schemaType: "CollectionPage", roles: {} };

function spec(m: SchemaMapping) {
  const s = SCHEMA_TYPES[m.schemaType];
  if (!s) throw new Error(m.schemaType);
  return s;
}

function rules(f: PluginAuditPageFacts, m: SchemaMapping): string[] {
  return pageDataFindings(f, m, spec(m)).map((x) => x.rule);
}

describe("graph reading", () => {
  it("finds the page's own node by type and @id, not an author's Person", () => {
    const nodes = graphNodes([
      {
        "@graph": [
          { "@type": "Person", "@id": `${URL_}/team/ana#person`, name: "Ana" },
          { "@type": "Person", "@id": `${URL_}/team/bo/#person`, name: "Bo" },
        ],
      },
    ]);
    expect(mainNode(nodes, "Person", "/team/bo")?.name).toBe("Bo");
    expect(mainNode(nodes, "Person", "/blog/x")).toBeNull();
  });
});

describe("article rules", () => {
  const article = (over: Record<string, unknown> = {}) => ({
    "@type": "BlogPosting",
    "@id": `${URL_}/blog/x#article`,
    headline: "Why we test",
    author: [{ "@id": `${URL_}/team/ana#person` }],
    ...over,
  });
  it("passes an article whose headline is its h1 and names an author", () => {
    expect(
      rules(facts("/blog/x", [article()], { headings: [heading("Why we test")] as never }), blog),
    ).toEqual([]);
  });
  it("finds a headline the page does not show", () => {
    expect(
      rules(facts("/blog/x", [article()], { headings: [heading("Other")] as never }), blog),
    ).toEqual(["structured-data-not-visible"]);
  });
  it("judges nothing a cut text list does not prove", () => {
    expect(
      rules(facts("/blog/x", [article()], { truncatedFacts: ["texts"] as never }), blog),
    ).toEqual([]);
  });
  it("finds an article without author where the type names authors", () => {
    const f = facts("/blog/x", [article({ author: undefined })], {
      headings: [heading("Why we test")] as never,
    });
    expect(rules(f, blog)).toEqual(["article-author-missing"]);
    expect(rules(f, { ...blog, roles: {} })).toEqual([]);
  });
});

describe("person and overview rules", () => {
  it("finds a person's page without biography, portrait or profile link", () => {
    const f = facts(
      "/team/ana",
      [{ "@type": "Person", "@id": `${URL_}/team/ana#person`, name: "Ana" }],
      {
        headings: [heading("Ana")] as never,
      },
    );
    const found = pageDataFindings(f, person, spec(person));
    expect(found.map((x) => x.rule)).toEqual(["author-page-incomplete"]);
    expect(found[0]?.message).toContain("has no biography, portrait or profile link");
  });
  it("finds a person without a name as missing a required property", () => {
    const f = facts("/team/ana", [
      {
        "@type": "Person",
        "@id": `${URL_}/team/ana#person`,
        description: "Writes.",
        image: "x.jpg",
        sameAs: ["https://example.org/ana"],
      },
    ]);
    expect(rules(f, person)).toEqual(["structured-data-required"]);
  });
  it("finds an overview that lists nothing, and passes one that lists pages", () => {
    const empty = facts("/topics/tea", [
      { "@type": "CollectionPage", "@id": `${URL_}/topics/tea#webpage` },
    ]);
    expect(rules(empty, overview)).toEqual(["overview-empty"]);
    const full = facts("/topics/tea", [
      { "@type": "CollectionPage", "@id": `${URL_}/topics/tea#webpage` },
      {
        "@type": "ItemList",
        "@id": `${URL_}/topics/tea#items`,
        itemListElement: [{ "@type": "ListItem", position: 1, url: `${URL_}/blog/x` }],
      },
    ]);
    expect(rules(full, overview)).toEqual([]);
  });
  it("finds a JSON-LD block that is no JSON, and judges no cut graph", () => {
    const f = facts("/x", [], {
      jsonLd: [
        {
          kind: "invalid",
          error: "Unexpected token",
          moduleId: "m",
          listItem: null,
          pluginSlug: null,
        },
        { kind: "omitted", chars: 70000, moduleId: null, listItem: null, pluginSlug: null },
      ] as never,
    });
    expect(rules(f, overview)).toEqual(["structured-data-invalid"]);
  });
});
