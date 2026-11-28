// SPDX-License-Identifier: MPL-2.0

/**
 * A blog as the structured-data point describes it, for the plugin's tests
 * (#1756): two authors, a reviewer, an article that names both authors in
 * order and is reviewed, a topic page listing its articles. Not part of the
 * plugin's build (tests only import it).
 */

import type { StructuredDataArgs, StructuredDataPage } from "@caelo-cms/plugin-sdk";
import type { SchemaMapping } from "../src/schema/mapping.js";

export const IDS = {
  anna: "a0000000-0000-4000-8000-000000000001",
  ben: "a0000000-0000-4000-8000-000000000002",
  cleo: "a0000000-0000-4000-8000-000000000003",
  article: "b0000000-0000-4000-8000-000000000001",
  second: "b0000000-0000-4000-8000-000000000002",
  topic: "c0000000-0000-4000-8000-000000000001",
  portrait: "d0000000-0000-4000-8000-000000000001",
  hero: "d0000000-0000-4000-8000-000000000002",
  tags: "e0000000-0000-4000-8000-000000000001",
  seoTag: "e0000000-0000-4000-8000-000000000002",
} as const;

const base = {
  isHome: false,
  lang: "en",
  description: "",
  shareImage: null,
  live: true,
  publishedAt: "2026-11-01T09:00:00.000Z",
  terms: [],
  propertyTerms: [],
  listed: [],
} as const;

/** An author page of the `author` page type. */
function author(
  id: string,
  shortTitle: string,
  properties: Record<string, unknown>,
): StructuredDataPage {
  return {
    ...base,
    pageId: id,
    pageType: "author",
    path: `/team/${shortTitle.split(" ")[0]?.toLowerCase()}`,
    title: `About ${shortTitle}`,
    shortTitle,
    description: `${shortTitle} writes about search.`,
    properties,
  };
}

export const anna = author(IDS.anna, "Anna Berg", {
  role: "Head of SEO",
  portrait: `caelo:media/${IDS.portrait}`,
  bio: "<p>Anna has worked on <strong>search</strong> since 2010 &amp; teaches it.</p>",
  linkedin: { href: "https://www.linkedin.com/in/anna-berg" },
  website: { href: "https://anna.example/" },
  team_page: { href: `caelo:page/${IDS.topic}` },
});
export const ben = author(IDS.ben, "Ben Okafor", { role: "Editor" });
export const cleo = author(IDS.cleo, "Cleo Park", { role: "Technical reviewer" });

export const article: StructuredDataPage = {
  ...base,
  pageId: IDS.article,
  pageType: "article",
  path: "/blog/json-ld-graph",
  title: "One JSON-LD graph per page",
  shortTitle: "JSON-LD graph",
  description: "Why fixed ids keep structured data apart.",
  shareImage: IDS.hero,
  properties: {
    authors: [`caelo:page/${IDS.ben}`, `caelo:page/${IDS.anna}`],
    reviewed_by: [`caelo:page/${IDS.cleo}`],
    last_reviewed: "2026-11-20",
  },
  terms: [
    {
      vocabulary: "tags",
      listId: IDS.tags,
      itemId: IDS.seoTag,
      name: "SEO",
      slug: "seo",
      overviewPageId: IDS.topic,
    },
  ],
};

export const topic: StructuredDataPage = {
  ...base,
  pageId: IDS.topic,
  pageType: "topic",
  path: "/topics/seo",
  title: "SEO",
  shortTitle: "SEO",
  description: "Everything we wrote about SEO.",
  properties: {},
  listed: [IDS.article, IDS.second],
};

export const pageTypes: StructuredDataArgs["pageTypes"] = {
  article: {
    properties: [
      { name: "authors", type: "page", multiple: true },
      { name: "reviewed_by", type: "page" },
      { name: "last_reviewed", type: "date" },
    ],
  },
  author: {
    properties: [
      { name: "role", type: "text" },
      { name: "portrait", type: "media" },
      { name: "bio", type: "richtext" },
      { name: "linkedin", type: "link" },
      { name: "website", type: "link" },
      { name: "team_page", type: "link" },
    ],
  },
  topic: { properties: [] },
};

export const mappings = new Map<string, SchemaMapping>([
  [
    "article",
    {
      pageType: "article",
      schemaType: "BlogPosting",
      roles: {
        authors: "prop:authors",
        reviewer: "prop:reviewed_by",
        reviewed_on: "prop:last_reviewed",
      },
    },
  ],
  [
    "author",
    {
      pageType: "author",
      schemaType: "ProfilePage",
      roles: {
        job_title: "prop:role",
        image: "prop:portrait",
        bio: "prop:bio",
        same_as: ["prop:linkedin", "prop:website", "prop:team_page"],
        works_for: "organization",
      },
    },
  ],
  ["topic", { pageType: "topic", schemaType: "CollectionPage", roles: {} }],
]);

/** The point's arguments for these pages, with the authors and reviewer as related pages. */
export function argsFor(pages: StructuredDataPage[]): StructuredDataArgs {
  return {
    pages,
    related: [anna, ben, cleo, topic],
    pageTypes,
    site: { organization: true, name: "Example Blog" },
  };
}
