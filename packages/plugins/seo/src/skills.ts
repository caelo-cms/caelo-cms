// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's companion skills (the `companion_skills` grant). They go
 * live and archive with the plugin (CLAUDE.md §2): the `## Skills` index is
 * the only surface that tells the AI what the plugin can do.
 *
 * Written in the operator's terms (CLAUDE.md §1A): the operator says "the
 * blog should show who wrote each article"; the AI decides the page types,
 * modules, mapping and checks. Bodies stay short; the rules that prevent a
 * failed call live in the tool texts, not here.
 */

import type { PluginSkillSpec } from "@caelo-cms/plugin-sdk";
import { CRAWLER_POLICY_SKILL, SEO_AUDIT_SKILL } from "./skills-checks.js";

const SCHEMA_MAPPING: PluginSkillSpec = {
  slug: "seo-schema-mapping",
  displayName: "Structured data per page type",
  description:
    "Give each kind of page the right structured data (JSON-LD) for search engines: articles with authors and dates, people, overview pages, locations, events, jobs, products, videos.",
  body: [
    "The operator asks for rich results, structured data or schema ('Google should know these are articles'). They do not think in schema types: decide per page type, then report in their words.",
    "",
    "1. get_schema_mapping: every page type, its properties and its current mapping, and the schema types with their roles.",
    "2. Pick per page type: blog posts BlogPosting, news NewsArticle, other editorial Article, a page about one person ProfilePage, overviews of other pages CollectionPage, one location LocalBusiness, an event Event, an open position JobPosting, a product Product, a page that is one video VideoObject. Everything else stays WebPage (core writes it anyway).",
    "3. Map each role to a property the page SHOWS (Google: markup must match the visible text). A missing property: add it with upsert_page_types_many and show it in the type's template before mapping it.",
    "4. ONE set_schema_mappings_many for all page types. It is a draft change: offer the Stage; inspect_page_render on one page per type shows the JSON-LD graph.",
    "",
    "Core writes one graph per page (Organization, WebSite, WebPage, BreadcrumbList with fixed ids); never write JSON-LD into module markup: the Stage reports it.",
  ].join("\n"),
  autoEngagementHints: {
    keywords: [
      "structured data",
      "schema",
      "json-ld",
      "rich result",
      "rich snippet",
      "strukturierte daten",
    ],
  },
};

const AUTHOR_PAGES: PluginSkillSpec = {
  slug: "seo-author-pages",
  displayName: "Author pages and bylines",
  description:
    "Show who wrote and who reviewed each article, with a page per author that lists their articles: Person and ProfilePage markup, authors linked from every article.",
  body: [
    "The operator says 'show who wrote each article', 'we need author pages' or 'add expert review'. An author is a normal page of its own page type, never a login account.",
    "",
    '1. Page type `author` (collection: true) with properties the author box shows: role (text), portrait (media), bio (richtext), profile links (one link property each: linkedin, website, …). Template: the author box module, then a list of their articles: a `list` field bound to a page query `{page_type:<article type>, refers_to:{property:"authors", page:"self"}, order:"published_desc"}` with `paginate:{}` (all articles, with a pager).',
    "2. The article page type gets `authors` (type page, multiple, pageType author) and, for reviewed content, `reviewed_by` (type page) and `last_reviewed` (date). ONE upsert_page_types_many for both types.",
    '3. Byline module in the article template: `{{#page.props.authors}}<a href="{{link}}">{{title}}</a>{{/page.props.authors}}` in the order the article names them; the review line shows the reviewer AND the date (`{{page.props.last_reviewed.formatted}}`): Google wants the review date visible.',
    "4. Build the author pages (build_page, one per author), then set each article's authors with update_pages_many (paths are fine).",
    "5. set_schema_mappings_many: author → ProfilePage {job_title, image, bio, same_as: the link properties, works_for: organization when they work for the site's company}; article → BlogPosting (or NewsArticle/Article) {authors, reviewer, reviewed_on}.",
    "6. Offer the Stage; the articles then carry each author as a Person linked to their page.",
  ].join("\n"),
  autoEngagementHints: {
    keywords: [
      "author",
      "authors",
      "byline",
      "author page",
      "reviewed by",
      "autor",
      "autorenseite",
      "e-e-a-t",
    ],
  },
};

const TOPIC_PAGES: PluginSkillSpec = {
  slug: "seo-topic-pages",
  displayName: "Topic pages and internal links",
  description:
    "Curated topic pages for the site's important tags and categories, merged duplicate terms, and internal links between related pages.",
  body: [
    "A tag or category never makes a page by itself: only important topics get a real topic page, the rest stay internal order without a URL.",
    "",
    "1. list_topic_terms: published pages per term, `suggestTopicPage` for terms with enough articles and no page, `nearDuplicates` for one topic spelt twice. Propose the topic pages and merges to the operator in their words; merge only what they agree to (merge_terms re-tags the pages and redirects a merged term's topic page in one call).",
    '2. A topic page is a normal page (page type `topic`): an intro in the site\'s voice, a few key articles, then a `list` field bound to a page query `{terms:["caelo:term/<listId>/<itemId>"], order:"published_desc"}` with `paginate:{}`.',
    '3. Name it the term\'s overview page: patch_list_items_many on the vocabulary, `landing_page` of the term. Term chips (`{{#link}}<a href="{{link}}">{{name}}</a>{{/link}}`) and breadcrumbs then lead there.',
    "4. Map the topic page type to CollectionPage (set_schema_mappings_many): its list becomes an ItemList.",
    "5. Links: suggest_internal_links for a page names pages it should link to and why (shared terms, few links to it); add the links in the text where they fit. Stage: the audit warns about an article that does not link back to its topic page.",
  ].join("\n"),
  autoEngagementHints: {
    keywords: [
      "topic page",
      "tag page",
      "category page",
      "internal links",
      "themenseite",
      "interne links",
      "merge tags",
    ],
  },
};

/** Every skill the plugin ships. */
export const SEO_SKILLS: readonly PluginSkillSpec[] = [
  SCHEMA_MAPPING,
  AUTHOR_PAGES,
  TOPIC_PAGES,
  SEO_AUDIT_SKILL,
  CRAWLER_POLICY_SKILL,
];
