// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginAuditPageFacts, PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import {
  graphNodes,
  mainNode,
  pageDataFindings,
  STRUCTURED_DATA_AUDIT_RULE,
} from "./data-rules.js";
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

describe("the structured data rule family", () => {
  const ARTICLE = "00000000-0000-4000-8000-000000000001";
  const ANA = "00000000-0000-4000-8000-0000000000a1";
  const RUN = "00000000-0000-4000-8000-0000000000ff";
  const ctxOf = (noindexAuthor: boolean, mapped = true) => {
    const calls: string[] = [];
    const ctx = {
      adminQuery: {
        list: async () =>
          mapped
            ? [
                {
                  id: "m1",
                  page_type: "post",
                  schema_type: "BlogPosting",
                  roles: { authors: "prop:author" },
                },
              ]
            : [],
      },
      cms: {
        call: async (op: string, input: { pageIds?: string[]; paths?: string[] }) => {
          calls.push(op);
          if (op === "pages_seo.overview") {
            return {
              pages: (input.pageIds ?? []).map((pageId) => ({
                pageId,
                path: pageId === ANA ? "/team/ana" : "/blog/x",
                pageType: pageId === ANA ? "author" : "post",
                noindex: pageId === ANA && noindexAuthor,
              })),
              nextCursor: null,
            };
          }
          if (op === "quality_audits.staged_pages") {
            return { pages: (input.paths ?? []).map(() => ({ pageId: ANA, path: "/team/ana" })) };
          }
          throw new Error(op);
        },
      },
    } as unknown as PluginContextTier1;
    return { ctx, calls };
  };
  const article = facts(
    "/blog/x",
    [
      {
        "@type": "BlogPosting",
        "@id": `${URL_}/blog/x/#article`,
        headline: "Why we test",
        author: { "@id": `${URL_}/team/ana/#person` },
      },
    ],
    { pageId: ARTICLE, headings: [heading("Why we test")] as never },
  );

  it("names a noindex author page once, on that page", async () => {
    const found = await STRUCTURED_DATA_AUDIT_RULE.facts?.(ctxOf(true).ctx, {
      facts: [article],
      auditRunId: RUN,
    });
    expect(found?.map((f) => [f.rule, f.pageId])).toEqual([["author-page-noindex", ANA]]);
    const open = await STRUCTURED_DATA_AUDIT_RULE.facts?.(ctxOf(false).ctx, {
      facts: [article],
      auditRunId: RUN,
    });
    expect(open).toEqual([]);
  });

  it("judges nothing on a site without a mapping", async () => {
    const { ctx, calls } = ctxOf(true, false);
    expect(
      await STRUCTURED_DATA_AUDIT_RULE.facts?.(ctx, { facts: [article], auditRunId: RUN }),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
