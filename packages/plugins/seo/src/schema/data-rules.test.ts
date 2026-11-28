// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  indexCheckedQuery,
  manifestFromDefinition,
  type PluginAuditPageFacts,
  type PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import seo from "../index.js";
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
  it("reads a headline past punctuation at its ends (review #6)", () => {
    const f = facts("/blog/x", [article({ headline: "Why we test?" })], {
      headings: [heading("Why we test")] as never,
    });
    expect(rules(f, blog)).toEqual([]);
  });
  it("never quotes half of a character (review #8)", () => {
    const long = `${"x".repeat(79)}😀😀 end`;
    const found = pageDataFindings(
      facts("/blog/x", [article({ headline: long })], { headings: [heading("Other")] as never }),
      blog,
      spec(blog),
    );
    expect(found[0]?.message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
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
    // A team member's or speaker's page need not be an author's (review #5).
    expect(found[0]?.severity).toBe("warning");
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
  it("takes a remote job's jobLocationType for its jobLocation (review #3)", () => {
    const job: SchemaMapping = { pageType: "job", schemaType: "JobPosting", roles: {} };
    const node = (over: Record<string, unknown>) => ({
      "@type": "JobPosting",
      "@id": `${URL_}/jobs/dev#job`,
      title: "Developer",
      description: "Build things.",
      datePosted: "2026-11-01",
      hiringOrganization: { "@id": `${URL_}/#organization` },
      ...over,
    });
    expect(rules(facts("/jobs/dev", [node({ jobLocationType: "TELECOMMUTE" })]), job)).toEqual([]);
    expect(rules(facts("/jobs/dev", [node({})]), job)).toEqual(["structured-data-required"]);
  });
  it("leaves a JSON-LD block that is no JSON to core's check (review #4)", () => {
    const f = facts(
      "/topics/tea",
      [
        { "@type": "CollectionPage", "@id": `${URL_}/topics/tea#webpage` },
        {
          "@type": "ItemList",
          "@id": `${URL_}/topics/tea#items`,
          itemListElement: [{ "@type": "ListItem", position: 1, url: `${URL_}/blog/x` }],
        },
      ],
      {},
    );
    const withBroken = {
      ...f,
      jsonLd: [
        ...f.jsonLd,
        {
          kind: "invalid",
          error: "Unexpected token",
          moduleId: "m",
          listItem: null,
          pluginSlug: null,
        },
      ],
    } as unknown as PluginAuditPageFacts;
    expect(rules(withBroken, overview)).toEqual([]);
  });
});

describe("the structured data rule family", () => {
  const ARTICLE = "00000000-0000-4000-8000-000000000001";
  const ANA = "00000000-0000-4000-8000-0000000000a1";
  const RUN = "00000000-0000-4000-8000-0000000000ff";
  const ctxOf = (noindexAuthor: boolean, mapped = true) => {
    const calls: string[] = [];
    const ctx = {
      // The host's read rule applies: a read no index drives fails here (#1536).
      adminQuery: indexCheckedQuery(manifestFromDefinition(seo), "adminSchema", {
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
      }),
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

  // Pages of the other mapped types, through the family (it decides which
  // pages are judged).
  const familyCtx = (
    rows: { page_type: string; schema_type: string }[],
    info: Record<string, { pageType: string; noindex?: boolean }>,
  ) =>
    ({
      adminQuery: indexCheckedQuery(manifestFromDefinition(seo), "adminSchema", {
        list: async () => rows.map((r, i) => ({ id: `m${i}`, roles: {}, ...r })),
      }),
      cms: {
        call: async (op: string, input: { pageIds?: string[] }) => {
          if (op !== "pages_seo.overview") throw new Error(op);
          return {
            pages: (input.pageIds ?? []).flatMap((pageId) => {
              const i = info[pageId];
              return i
                ? [{ pageId, path: "/p", pageType: i.pageType, noindex: i.noindex ?? false }]
                : [];
            }),
            nextCursor: null,
          };
        },
      },
    }) as unknown as PluginContextTier1;
  const TOPIC = "00000000-0000-4000-8000-0000000000c1";
  const emptyTopic = (over: Partial<PluginAuditPageFacts> = {}) =>
    facts("/topics/tea", [{ "@type": "CollectionPage", "@id": `${URL_}/topics/tea#webpage` }], {
      pageId: TOPIC,
      ...over,
    });
  const topicCtx = (noindex = false) =>
    familyCtx([{ page_type: "topic", schema_type: "CollectionPage" }], {
      [TOPIC]: { pageType: "topic", noindex },
    });
  const run = async (ctx: PluginContextTier1, f: PluginAuditPageFacts) =>
    ((await STRUCTURED_DATA_AUDIT_RULE.facts?.(ctx, { facts: [f], auditRunId: RUN })) ?? []).map(
      (x) => x.rule,
    );

  it("judges an indexable empty overview, and none kept out of search (review #1)", async () => {
    expect(await run(topicCtx(), emptyTopic())).toEqual(["overview-empty"]);
    // What the overview-empty fix advises: noindex until it lists pages.
    expect(await run(topicCtx(), emptyTopic({ robots: "noindex, follow" }))).toEqual([]);
    expect(await run(topicCtx(true), emptyTopic())).toEqual([]);
  });

  it("judges no noindex JobPosting, which core leaves undated (review #1)", async () => {
    const JOB = "00000000-0000-4000-8000-0000000000d1";
    const job = facts(
      "/jobs/dev",
      [{ "@type": "JobPosting", "@id": `${URL_}/jobs/dev#job`, title: "Dev", description: "x" }],
      { pageId: JOB, robots: "noindex" },
    );
    const ctx = familyCtx([{ page_type: "job", schema_type: "JobPosting" }], {
      [JOB]: { pageType: "job" },
    });
    expect(await run(ctx, job)).toEqual([]);
  });

  it("judges no page whose canonical names another URL (review #2)", async () => {
    const PERSON = "00000000-0000-4000-8000-0000000000e1";
    // Core writes the page's nodes under its canonical URL.
    const ana = (canonicalPath: string) =>
      facts("/team/ana", [{ "@type": "Person", "@id": `${URL_}${canonicalPath}/#person` }], {
        pageId: PERSON,
        canonical: { href: `${URL_}${canonicalPath}/`, path: canonicalPath },
      });
    const ctx = familyCtx([{ page_type: "author", schema_type: "ProfilePage" }], {
      [PERSON]: { pageType: "author" },
    });
    expect(await run(ctx, ana("/people/ana"))).toEqual([]);
    // Canonical to itself: judged (here a Person without a name).
    expect(await run(ctx, ana("/team/ana"))).toEqual([
      "structured-data-required",
      "author-page-incomplete",
    ]);
  });

  it("judges no graph the facts budget cut (review #7)", async () => {
    expect(await run(topicCtx(), emptyTopic({ truncatedFacts: ["jsonLd"] as never }))).toEqual([]);
  });

  it("judges nothing on a site without a mapping", async () => {
    const { ctx, calls } = ctxOf(true, false);
    expect(
      await STRUCTURED_DATA_AUDIT_RULE.facts?.(ctx, { facts: [article], auditRunId: RUN }),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
