<!-- SPDX-License-Identifier: MPL-2.0 -->

# Structured data: one JSON-LD graph per page

Epic #1751, issues #1753 (graph, composition point, integrity check), #1756 (schema per page type, author pages, reviewed by), #1759 (topic pages), #1761 (special templates, news and video sitemaps).

Core writes everything that reaches a page; plugins answer with typed data that core checks and serializes (CLAUDE.md §2: no raw HTML into `<head>`). Structured data follows that rule: one `<script type="application/ld+json">` per page holds one `@graph` whose nodes are linked by fixed `@id`s, the pattern Yoast and Joomla 5 use. One owner per `@id` means a node cannot appear twice (the Shopify problem of a theme and an app both writing Product).

## Core's nodes

| Node | `@id` | When |
|---|---|---|
| Organization | `<site>/#organization` | the site has an Organization name (`site_defaults`) |
| WebSite | `<site>/#website` | always: `url`, `name` (the site name), `inLanguage`, `publisher` |
| WebPage (or a plugin's subtype) | `<page URL>` | always: `url`, `name` (the page title), `description`, `image`, `inLanguage`, `isPartOf`, `breadcrumb`, `publisher`, and `datePublished` / `dateModified` from the live page record |
| BreadcrumbList | `<page URL>#breadcrumb` | the page shows a trail (#1142) |

`<site>` is the site base URL and `<page URL>` the page's canonical, both from the one public URL builder (#590). The builder is `buildPageGraph` and the serializer `renderJsonLdScript` (`packages/shared/src/json-ld.ts`); the static build and the editor preview call both with the same inputs, so they write the same nodes (`seo-plugin-blog.integration.test.ts` compares the preview's graph with the build's on a fixture blog, the live dates aside). The serializer writes every `<` as `\u003c`, so no value closes the script.

A page outside the live record (a draft in the preview, a noindex page) carries no dates. In a build the dates are known only after the live comparison dated the page (the record's fingerprint does not read the head), so the graph carries the same pending marker as `article:modified_time` and `setArticleModifiedTime` dates both.

## The `structured_data` composition point

A plugin with the `structured_data` capability names a `structuredDataOperation` (an installed plugin answers through the reserved entry `$structuredData`). Core asks it in calls of at most 50 pages with `StructuredDataArgs` (plugin SDK `structured-data.ts`):

- `pages`: per page its type, path, language, title, short title, meta description, share image, properties as stored, terms (with each term's overview page), `listed` (the pages its lists show, in order), whether it has live dates and when it went live first;
- `related`: the pages they name through `page` properties and their terms' overview pages, one level deep (an article's authors);
- `pageTypes`: the property definitions of all of them;
- `site`: whether the Organization node exists, the site name.

The answer is `{pages: {<pageId>: {webPage?, nodes?}}}`. Values are typed, never free JSON: text (no markup, no URL), numbers, booleans, `{date}`, `{duration}`, `{live: "published" | "modified"}` (`"modified"` only as the one value of a `dateModified`, which the build dates once the live comparison has, else `live-modified-property`), `{page}` (core builds the URL), `{media}` (a library image core publishes), `{url}` (an address on another site), `{schema}` (a schema.org term), `{ref}` (an `@id`: a core node by name, `{fragment}` of the page, `{page, fragment}` named after another page), `{node}` (nested, three deep) and arrays of them. `@type` must be in core's list (`packages/shared/src/schema-org-types.ts`); a WebPage subtype one of `WEB_PAGE_TYPES`; WebPage properties only the allowlist (`reviewedBy`, `lastReviewed`, `about`, `mainEntity`, …).

The host checks every part (`packages/plugin-host/src/structured-data-vocabulary.ts`), resolves page and media ids (`structured-data.ts`) and hands the parts to the graph builder, which keeps one owner per `@id` and per WebPage property and refuses a reference that names no node of the page. Every refused part is a render failure `plugin-value-refused:<plugin>.structured-data.<field>:<rule>`: the preview lists it, a Stage records it, Publish live refuses the build. Caps: 32 nodes and 16 KB per page, 1 MB per answer, 5,000 characters per text, 50 entries per array. Adversarial cases (a `</script>` in a text, a free URL to this site, an unknown type, an oversized answer, an answer for a page not asked, a node claiming a core id) are tested in `structured-data-vocabulary.test.ts`, `json-ld.test.ts` and the installed-plugin flow (`external-structured-data.integration.test.ts`).

## The `structured-data` Stage check

A core check (`packages/admin-core/src/quality/checks/structured-data.ts`) reads every staged page's JSON-LD blocks as the audit's page facts read them (#1755) and treats them as one graph: invalid JSON, a missing graph, a reference that names no node (`dangling-id`) and two nodes with one `@id` (`duplicate-id`) are errors and block Publish live; extra blocks (structured data in a module's markup) and blocks too large to read are warnings. Type rules (required properties) are the `seo` plugin's findings.

## The `seo` plugin's mapping (#1756, #1761)

The plugin maps each page type to a schema type and its roles to the page's own fields (`packages/plugins/seo/src/schema/`): Article / BlogPosting / NewsArticle (authors as ordered Person references, reviewer and review date on the WebPage), ProfilePage (the full Person), CollectionPage (an ItemList of the pages its lists show, the first 50 in their order), and the templates LocalBusiness, Event, JobPosting, Product and VideoObject. The mapping is a row per page type in the plugin's own table `type_mappings`, written by `set_schema_mappings_many` after a check against the page type's properties; it is branch-aware like every plugin row, so a change is draft until a Stage and live with Publish live. Why a table and not `entityConfig.pageType`: a mapping is a record of role → source whose roles depend on the schema type, which config leaves cannot hold, and a plugin cannot check its own config before it is written.

## The `sitemap_entries` composition point (#1761)

Plugins own no routes and write no files. With the `sitemap_entries` capability a plugin names a `sitemapEntriesOperation` (`$sitemapEntries`), asked with the same page records, and answers `{pages: {<pageId>: {news?: {title}, videos?: [...]}}}` (plugin SDK `sitemap-entries.ts`). Core writes `sitemap-news.xml` and `sitemap-video.xml` (`packages/shared/src/sitemap-extras.ts`) from the entries of the pages `sitemap.xml` lists, and robots.txt names them next to `sitemap.xml`. The `seo` plugin lists NewsArticle pages that went live in the last 48 hours and VideoObject pages with thumbnail, description and the player on the video host. News entries need the site name (`<news:name>`); without it the host refuses them as a render failure that names the setting. `seo-plugin-topics-sitemaps.integration.test.ts` builds both files and robots.txt on a real Postgres.

## Topic pages and links (#1759)

The `seo` plugin's page-output observer (#1647) keeps an index of the published site (`packages/plugins/seo/src/topics/page-index.ts`): per page its type, terms and content links (the layout's menus left out). `list_topic_terms`, `suggest_internal_links` and the `topic-backlink` audit rule read it; `merge_terms` calls core's `lists.merge_terms`, which re-tags the pages, removes the merged terms and redirects a merged term's topic page in one transaction. A term's overview link is stored as a page reference; the tools resolve it to the page's current path. A term never makes a page by itself: a topic page is a normal page the AI builds and names the term's overview page (#1754).
