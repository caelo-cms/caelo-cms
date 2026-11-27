# seo

The shipped `seo` plugin (epic #1751, CMS_REQUIREMENTS §14.11): the SEO
knowledge that changes with search engines, as a plugin under the same
rules as every other one (CLAUDE.md §2: one plugin model).

## Core writes, the plugin answers with data

Core writes everything that reaches a page: the head, the JSON-LD, the
sitemap, robots.txt, every file at a path. This plugin returns typed data
only, and core checks, escapes or refuses it:

- schema nodes for the page's JSON-LD graph (the `structured_data`
  composition point),
- findings for the Stage audit: objective rules only; an error blocks
  Publish live until it is fixed or accepted,
- write hints after the AI writes: rules of thumb (lengths, style,
  "link this page?"), never findings,
- proposals for gated changes (robots.txt rules), which the Owner approves.

Plugin code has no network and owns no routes (#1729). Since PR #1732 a
plugin's head entries are limited to hreflang alternates and `og:locale`
for every plugin, so nothing here writes a `<meta>` or `<link>`.

## Features

**Structured data (#1753, #1756, #1761).** Each page type maps to one
schema.org type (`set_schema_mappings_many`; `get_schema_mapping` shows the
mapping, every type's roles and what each page type offers). A mapping is a
row of the plugin's private storage, so one set in a chat is a draft of that
chat until Publish live. Roles read the page record: its title, description,
share image and dates, and its page-type properties (`prop:<name>`).
`structured_data` answers the nodes per page; core joins them into the
page's one graph ([`docs/dev/structured-data.md`](../../../docs/dev/structured-data.md)).

- Articles (`Article`, `BlogPosting`, `NewsArticle`): authors from a page
  property of kind `page` (several, in order), each a `Person` node of its
  author page; `reviewedBy` and `lastReviewed` on the WebPage. The review
  date must be visible on the page; the companion skill says how.
- Author pages: a page type mapped to `ProfilePage` is the WebPage of a
  `Person` (`#person`), with role, bio, portrait, `sameAs` links and the
  organization. Its list of articles is a page query `refers_to` the page.
- Topic pages (`CollectionPage`): an `ItemList` of the pages its lists show.
- Special templates: `LocalBusiness` (address, opening hours, geo),
  `Event`, `JobPosting`, `Product` (offers from page properties) and
  `VideoObject`.
- `sitemap_entries`: news articles of the last 48 hours and video pages,
  which core writes to `sitemap-news.xml` and `sitemap-video.xml`. News
  needs the site name (Settings → Site identity).

**Topic pages and internal links (#1759).** Read from the published site
of the last Stage (the page-output observer keeps the `page_index`):

- `list_topic_terms`: how many published pages carry each term, which term
  has enough (`topic_page_threshold`, 5) and no topic page yet, and
  near-duplicate terms with the one to keep.
- `merge_terms`: merges duplicate terms in one call (core's
  `lists.merge_terms`): pages re-tagged, the merged terms removed, a
  merged term's topic page redirected to the kept term's (or made the kept
  term's, when it has none). A draft change of the chat.
- `suggest_internal_links`: pages to link from or to a page, each with its
  reasons (shared terms, page type, no inbound links), and the page's
  inbound links and click depth.
- A write hint names the topic page a write mentions, unless the write
  links it; the backlink rule warns when a page carrying a term does not
  link its topic page.

Companion skills: `seo-schema-mapping`, `seo-author-pages`,
`seo-topic-pages`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | the definition: capabilities, hooks, settings, tools, skills |
| `src/operations.ts` | every operation by name; hooks and tools name them |
| `src/checks/` | the Stage audit: `SEO_AUDIT_RULES`, one file per rule family |
| `src/hints/` | write hints: `SEO_WRITE_HINT_RULES`, one file per family |
| `src/tools.ts` | the AI's tools (`SEO_TOOLS`) |
| `src/skills.ts` | the companion skills (`SEO_SKILLS`), live with the plugin |
| `src/config.ts` | the settings (`SEO_CONFIG`), core's plugin configuration |
| `src/rule-sets.ts` | the audit rules and write hints of every family, joined (the validator allows imports into the same folder or below only) |
| `src/schema/` | schema mapping, the nodes per page type, the news and video sitemap entries |
| `src/topics/` | the page index, topic terms, term merging, link suggestions, the backlink rule and the topic hint |

A feature adds files of its own and one entry in each list it uses.

### The audit runner

`checks/index.ts` is the contract with core's audit. Each rule family has
an optional `site` part (first call, once per Stage: read site-wide data
here) and an optional `facts` part (once per batch of up to 200 staged
pages with the facts core read from their HTML). The first answer asks
for fact batches with `batchPages: "own"`, so a batch call carries only
its own pages and costs the same on a small and a large site (#1721).

## Tests

`bun run test` from the repository root runs `src/*.test.ts`. The
plugin-host suite checks the built definition through the disk-load
pipeline (`shipped-plugins-validate.test.ts`) and pins its public surface
(`public-surface.test.ts`: none).
