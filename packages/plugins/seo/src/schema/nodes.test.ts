// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  anna,
  argsFor,
  article,
  ben,
  IDS,
  mappings,
  pageTypes,
  topic,
} from "../../test/fixture-blog.js";
import { mappingProblems } from "./mapping.js";
import { structuredDataAnswer } from "./nodes.js";
import { plainText } from "./values.js";

describe("seo structured data on a blog (#1756)", () => {
  it("writes a BlogPosting with both authors in order, each a Person of the graph", () => {
    const answer = structuredDataAnswer({ args: argsFor([article]), mappings });
    const page = answer.pages[IDS.article];
    expect(page?.nodes?.[0]).toEqual({
      type: "BlogPosting",
      id: { fragment: "article" },
      properties: {
        headline: "One JSON-LD graph per page",
        description: "Why fixed ids keep structured data apart.",
        image: { media: IDS.hero },
        datePublished: { live: "published" },
        dateModified: { live: "modified" },
        author: [
          { ref: { page: IDS.ben, fragment: "person" } },
          { ref: { page: IDS.anna, fragment: "person" } },
        ],
        publisher: { ref: "organization" },
        mainEntityOfPage: { ref: "webpage" },
        inLanguage: "en",
      },
    });
    // Each author's Person, named after the author's page: what the author
    // page's own mapping says (name, url, role, portrait).
    expect(page?.nodes?.slice(1).map((n) => n.id)).toEqual([
      { page: IDS.ben, fragment: "person" },
      { page: IDS.anna, fragment: "person" },
      { page: IDS.cleo, fragment: "person" },
    ]);
    expect(page?.nodes?.[2]?.properties).toEqual({
      name: "Anna Berg",
      url: { page: IDS.anna },
      jobTitle: "Head of SEO",
      image: { media: IDS.portrait },
    });
  });

  it("puts reviewedBy and the review date on core's WebPage", () => {
    const page = structuredDataAnswer({ args: argsFor([article]), mappings }).pages[IDS.article];
    expect(page?.webPage).toEqual({
      properties: {
        reviewedBy: { ref: { page: IDS.cleo, fragment: "person" } },
        lastReviewed: { date: "2026-11-20" },
      },
    });
  });

  it("leaves out an author the render does not ship", () => {
    const args = { ...argsFor([article]), related: [anna] };
    const page = structuredDataAnswer({ args, mappings }).pages[IDS.article];
    expect(page?.nodes?.[0]?.properties.author).toEqual({
      ref: { page: IDS.anna, fragment: "person" },
    });
    // The review date stays: the page shows it whoever reviewed.
    expect(page?.webPage).toEqual({ properties: { lastReviewed: { date: "2026-11-20" } } });
  });

  it("writes an author page as ProfilePage with the full Person", () => {
    const page = structuredDataAnswer({ args: argsFor([anna]), mappings }).pages[IDS.anna];
    expect(page).toEqual({
      webPage: { type: "ProfilePage", properties: { mainEntity: { ref: { fragment: "person" } } } },
      nodes: [
        {
          type: "Person",
          id: { fragment: "person" },
          properties: {
            name: "Anna Berg",
            url: { page: IDS.anna },
            jobTitle: "Head of SEO",
            image: { media: IDS.portrait },
            description: "Anna has worked on search since 2010 & teaches it.",
            // The team page link is a page of the site: not a profile elsewhere.
            sameAs: [
              { url: "https://www.linkedin.com/in/anna-berg" },
              { url: "https://anna.example/" },
            ],
            worksFor: { ref: "organization" },
          },
        },
      ],
    });
  });

  it("writes a topic page as CollectionPage with the listed pages in order", () => {
    const page = structuredDataAnswer({ args: argsFor([topic]), mappings }).pages[IDS.topic];
    expect(page?.webPage).toEqual({
      type: "CollectionPage",
      properties: { mainEntity: { ref: { fragment: "items" } } },
    });
    expect(page?.nodes?.[0]?.properties).toEqual({
      itemListElement: [
        { node: { type: "ListItem", properties: { position: 1, url: { page: IDS.article } } } },
        { node: { type: "ListItem", properties: { position: 2, url: { page: IDS.second } } } },
      ],
      numberOfItems: 2,
    });
  });

  it("answers nothing for a page type without a mapping, and no Organization when the site has none", () => {
    expect(structuredDataAnswer({ args: argsFor([ben]), mappings: new Map() }).pages).toEqual({});
    const args = { ...argsFor([article]), site: { organization: false, name: null } };
    const props = structuredDataAnswer({ args, mappings }).pages[IDS.article]?.nodes?.[0]
      ?.properties;
    expect(props?.publisher).toBeUndefined();
  });

  it("reads richtext as plain text", () => {
    expect(plainText("<p>A &lt;b&gt; tag &amp; <em>more</em></p>\n<p>x</p>")).toBe(
      "A <b> tag & more x",
    );
  });
});

describe("schema mapping checks (#1756)", () => {
  const props = pageTypes.article?.properties ?? [];

  it("accepts the blog's mappings", () => {
    for (const m of mappings.values()) {
      expect(mappingProblems(m, pageTypes[m.pageType]?.properties ?? [])).toEqual([]);
    }
  });

  it("names a missing property, a source of the wrong kind and an unknown role", () => {
    expect(
      mappingProblems(
        {
          pageType: "article",
          schemaType: "BlogPosting",
          roles: { authors: "prop:writers", reviewed_on: "prop:reviewed_by", colour: "title" },
        },
        props,
      ),
    ).toEqual([
      'role "authors": the page type has no property "writers" (its properties: authors (page), reviewed_by (page), last_reviewed (date)); add it with upsert_page_types_many first',
      'role "reviewed_on" takes date, and prop:reviewed_by is page',
      'BlogPosting has no role "colour" (its roles: authors, image, reviewer, reviewed_on)',
    ]);
    expect(
      mappingProblems({ pageType: "article", schemaType: "FAQPage", roles: {} }, props)[0],
    ).toContain("is not one the plugin writes");
    expect(
      mappingProblems(
        { pageType: "article", schemaType: "BlogPosting", roles: { authors: ["prop:authors"] } },
        props,
      ),
    ).toEqual(['role "authors" takes one source, not a list']);
  });
});
