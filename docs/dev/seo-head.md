# The SEO head of a page

Developer reference for #1752 (epic #1751, CMS_REQUIREMENTS §11): which
value each SEO tag in a page's `<head>` shows, where it comes from, and
who may change it. The resolver is
[`packages/shared/src/seo-head.ts`](../../packages/shared/src/seo-head.ts)
(`resolvePageSeoHead`); `renderSeoHead` in `seo.ts` writes the tags.

## 1. Fields

`pages_seo` (migrations 0027, 0880), one row per page, all draft state
(#1156: a chat's write is a pending page change, merged by the Stage):

| column | meaning | empty / default |
|---|---|---|
| `seo_title` | the page's own `<title>` | `''` = the title template renders |
| `meta_description` | `<meta name="description">` | `''` = none (a Stage refuses a published page without one) |
| `og_title`, `og_description` | Open Graph overrides | `''` = shared, see §3 |
| `noindex`, `nofollow`, `noarchive`, `nosnippet`, `noimageindex` | robots directives | `false` |
| `max_snippet`, `max_video_preview` | robots limits, `-1` = no limit, `0` = none | `NULL` = no directive |
| `max_image_preview` | `none` \| `standard` \| `large` | `large` |
| `nosnippet_content` | content instance ids of the page placements rendered with `data-nosnippet` | `[]` |
| `value_origins` | who wrote each non-empty own text | `{}` |

All directives render as **one** `<meta name="robots">`
(`robotsMetaContent`, fixed order); every page has one, because
`max-image-preview` always renders. Only `noindex` removes a page from the
sitemap, the feed and the live record (`isSitemapEntry`): no other
directive means "not indexed".

`data-nosnippet` is set per placement, addressed by block and position
(`nosnippetPlacements`) and stored as the content instance the placement
shows, so it follows the placement when modules move. The composer marks
the root of such a placement (`markNosnippet`): the attribute on a `div`,
`section` or `span` root, the only elements search engines read it on,
else a wrapping `<div data-nosnippet="">`. Build (`page-batch.ts`) and
preview set `ComposeModule.nosnippet` from the same stored list.

## 2. Origins

Every resolved value carries an origin (`SEO_VALUE_ORIGINS`):

- `human`, `ai`, `reviewed` — the page's own text, written by a person, by
  the AI (a translation included), or by the AI and confirmed by a person;
- `page_type` — the page type's title template or og:type;
- `site` — the site's title template, or og:type `website`;
- `inherited` — shared from another value of the page (`inheritsFrom`);
- `unset` — no value.

`value_origins` records the first three per text. Every SEO write goes
through `commitPageSeoWrites`, which stamps them (`authorshipAfterWrite`):
a changed text is the writer's (`human` for a person, `ai` for anyone
else), an unchanged one keeps its origin, an emptied one has none. Only a
person marks an AI text `reviewed` (`pages_seo.set` `reviewed`, the SEO
panel's checkbox); the op refuses it from any other actor.

Texts written before 0880, or by the previous release during an update,
carry no origin. The migration backfilled, and `completeSeoOrigins`
applies to such a text when it is read, the same rule: `ai` when the
page's SEO was ever autofilled or optimized, else `human`.

## 3. Precedence: site → page type → page

| tag | page's own | else |
|---|---|---|
| `<title>` | `seo_title` | the page type's `seo.titleTemplate`, else `site_defaults.seo_title_template` |
| `og:title` | `og_title` | the own `seo_title`, else the page title |
| `og:description` | `og_description` | the meta description, else none |
| `og:type` | — | the page type's `seo.ogType`, else `website` |
| `og:site_name` | — | `site_defaults.site_name`, no tag while unset |

The templates are stored data, never values made up at read time
(CLAUDE.md §2). `site_defaults.seo_title_template` is `NOT NULL`; 0880
stored `{page_title}`, the title every page had before, so no page's title
changed with the migration. A page type's `PageTypeDef.seo` is optional:
absent (or a key of it absent), the page type adds nothing and the site's
value stands. `website` is the Open Graph protocol's own meaning of a page
that declares no type.

**Variables:** `{page_title}`, `{short_title}`, `{site_name}`. A template
must contain `{page_title}` or `{short_title}` (or every page of it gets
the same title) and holds no other braces (`titleTemplateIssue`, checked by
Zod at every write and again when read). A variable without a value
(`{site_name}` before the site has a name) stays raw in the title and is
reported, never replaced: the preview flags
`seo-title-variable-unset:<variable>`, a Stage ships it as the preview
shows it and records the render failure (Publish live refuses the build),
every other build refuses. `page_types.set_seo_many` refuses a template
with `{site_name}` while the site has no name.

## 4. Article dates

A page whose og:type is `article` carries `article:published_time`
(`pages.first_published_at`) and `article:modified_time`: the date what
the page shows last changed live, the same date its sitemap `<lastmod>`
and feed entry show (docs/dev/search-engine-feed.md). Only an indexable
page 1 has them, because only those are in the live record.

- **Build:** the date is known only after the live comparison, which reads
  the finished page (plugin regions included). `apply` renders
  `ARTICLE_MODIFIED_TIME_PENDING`; `recordStates` replaces it
  (`setArticleModifiedTime`) and refuses a page that kept it.
- **Plugin-data build:** a page whose baked data moved its date gets the
  same date in its `article:modified_time` (`patchSearchFiles`).
- **Preview:** the dates of what is live now (the record's newest row). A
  page not live yet shows none; its first build dates it.

The resolved `<title>` (not the page title) is part of the content
fingerprint: a new title is a change of the page.

## 5. Fill-once

CLAUDE.md §2 extends to the new texts:

- `pages_seo.autofill` keeps the meta description's rule (the first fill
  writes it, a different text later is `AlreadyAutofilled`). `seoTitle`,
  `ogTitle`, `ogDescription` are filled only while empty **and** while the
  page was never published live (an empty one there is no gap: the
  template and the shared texts render); a different stored text is
  `AlreadyFilled`; the same text again is a no-op.
- `pages_seo.apply_translation` decides per text: an empty text or a page
  that is not live is filled; a live page's own text is kept and the page
  marked stale for an explicit re-optimization.
- `pages_seo.optimize` / `optimize_many` and `pages_seo.set` are the
  explicit paths and may change any text.

## 6. Ops and tools

| op | tool | |
|---|---|---|
| `pages_seo.get`, `pages_seo.get_many` | `get_page_seo` | stored fields + `resolved` head with origins |
| `pages_seo.set_many` | `set_page_seo_many` | exact values, robots, `nosnippetPlacements` |
| `pages_seo.autofill_many` | `autofill_page_seo_many` | first texts (§5) |
| `pages_seo.optimize_many` | `bulk_optimize_seo` | explicit rewrite of any text |
| `page_types.set_seo_many` | `set_page_type_seo_many` | title template + og:type per page type, the site template (bulk, one call) |
| `site_defaults.get_seo` | `get_site_seo` | shows the site template and name |

`page_types.set_seo_many` is a structure write (`content.structure`) and
routine (§11.A: one call sets the old template back). A write that takes
another chat's pending edit of the type over builds on it (re-read after
the lock). The site name, the site template and every page type's `seo`
are in the render fingerprint (`ops/quality/render-fingerprint.ts`): a
direct production build after one changed is refused until a Stage. The page type part
is draft state like every page type write; the site template is a site
setting that renders into page HTML, live with the next Stage and Publish
live, like the site name and language. `page_types.upsert_many` keeps a
type's stored `seo` when the replacement does not name it.

The editor's SEO info (`PageSeoInfo.svelte`) and the page's SEO panel
(`/content/pages/<id>/seo`) show every resolved value with its origin
(`lib/seo-origin.ts`); the panel edits the own texts and directives and
marks AI texts reviewed.

## 7. Translation

The `international-site` plugin translates the own SEO title, og:title and
og:description like the meta description (`HEAD_TEXT_KEYS`,
`translation-contract.ts`): a key in the answer contract only when the
source page has the text, required in full mode and while the variant has
none, nullable in an update; a text the source lacks is refused. The
answer goes to `pages_seo.apply_translation` (§5). The texts join the
source fingerprint only when present, so a page without them fingerprints
exactly as before and no variant turned stale with the upgrade. Title
templates are not translated per variant: their variables are.

## 8. Compatibility

0880 is expand-only: new columns with defaults; the previous image never
names them. Page SEO snapshot states and page type definitions written
before it lack the new keys; their parse adds the column defaults
(`PAGE_SEO_HEAD_COLUMN_DEFAULTS`, input normalisation of an older
encoding), and the branch overlay (`pageSeoViewSql`) reads an absent key
the same way.

## 9. Tests

- unit: `packages/shared/src/seo-head.test.ts` (resolver, templates,
  robots, origins, article dates, `markNosnippet`), `seo.test.ts`,
  `international-site/src/head-texts-contract.test.ts`;
- integration: `packages/admin-core/src/__tests__/seo-head-fields.integration.test.ts`
  (precedence and origins, reviewed, fill-once, translation, robots and
  the sitemap, `data-nosnippet`, preview == build head of an article
  dated from the live record, draft state);
- E2E: `apps/admin/e2e/live-edit-page-seo-info.browser.ts` (origins in the
  editor's SEO info, the panel's own title and reviewed mark).
