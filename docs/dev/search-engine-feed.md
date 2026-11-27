# Feed, WebSub and IndexNow

Search engines read a sitemap for the whole site and a feed for what is new.
Google recommends both. Since its sitemap ping went away (2023), WebSub is the
push path Google still names for telling it about changes. IndexNow is the
push path of Bing, Yandex, Seznam, Naver and Yep: one submission reaches all
of them. Caelo does all three for every site, and dates each page by when what
it shows changed live.

| Piece | Where |
|---|---|
| The live record per page | `live_page_versions` (migration 0710), `packages/admin-core/src/search-feed/live-versions.ts` |
| What a build changes | `ContentStates` (`apps/static-generator/src/content-states.ts`), fingerprint in `content-fingerprint.ts` |
| `/feed.xml` (Atom 1.0) | `apps/static-generator/src/atom-feed.ts`, written by `generate.ts` |
| Sitemap `<lastmod>` | `seo-pass.ts`, from the same record |
| IndexNow key file `/<key>.txt` | `generate.ts`; key in `site_defaults.indexnow_key` |
| Queueing the pings | `search-feed/notifications.ts`, in the transaction that records the run |
| Sending them | `search-feed/notify.ts`, ops `search_notify.claim` / `search_notify.record` |
| Retries | scheduler task `core:search-notify`, every tick |
| Settings | `site_defaults.feed_enabled`, `indexnow_enabled` through `site_defaults.set_seo` (gated for the AI: `propose_set_site_seo`) |
| What the operator sees | Settings → SEO; the AI reads the same through `get_site_seo` |

## When a page changed

A page's date moves when what the page itself shows changes: its title (the
`<title>` a search result shows, which a title template may make, #1752), its
meta description, and the visible text, link targets, image sources and
alternative texts of its own body. The body is the template with the page's
modules, as it fills the layout's `content` slot (`composePageWithLayout`
returns it as `contentHtml`). The layout's header and footer are not part of
it: a footer edit on a 5,000-page site is not 5,000 changed pages, and a date
that moves on every Publish live is soon ignored. Markup, classes, styles and
scripts do not count either.

`pages.updated_at`, which the sitemap used before, moves on a draft edit of
the page row only. A text edit inside a module never moved it, and it is not
when the change went live.

## The live record

`live_page_versions` is append-only. Each row is one page's live state from a
production run on: its URL, the fingerprint, and `changed_at`. The newest row
per page is what production serves. Only the runs that change production
append, in the transaction that records the run:

- **Stage.** The build compares every indexable page with the record (the
  same set the sitemap lists: not noindex, not the 404 page, not excluded by
  a plugin). Unchanged pages keep their date. A changed, moved or new page is
  dated with the run's start (`publishAt`, the instant `first_published_at`
  uses), so the HTML, the feed, the sitemap and the database agree. A full
  build also knows which live pages it no longer ships (`removed`). The Stage
  keeps this delta in `staged_page_changes`, with the record's head it was
  computed against (`deploy_runs.live_versions_base`). The two newest Stages
  keep their rows.
- **Publish live** appends the staged delta (`applyStagedRun`). When the
  record moved since the Stage (a rollback or an Owner's build in between),
  the delta no longer leads from what is live to what ships. The shipped state
  is then rebuilt (the record at the Stage's base, plus the delta) and
  compared with what is live now.
- **An Owner's production build** appends its own delta the same way.
- **Rollback** appends the restored build's state, read back from the record
  at that run's head (`deploy_runs.live_versions_head`). Each restored page
  keeps the date it had in that build, the date its restored feed and
  sitemap show, so the record describes the files served; a page the build
  did not ship is removed as of the rollback. IndexNow still gets the URLs
  that changed. When the content is the same but the restored files date it
  otherwise (it changed and changed back in between), a `redated` row gives
  the record that date; it is never announced. A Publish live of a Stage
  rebuilt against a moved record does the same for the pages it shows as
  they are live. A build from before
  the record began has no state to restore. Then nothing is appended until
  the next Publish live. A plugin-data release (#1155) appends its own
  rows and serves its base release's feed and key file, so a rollback to it
  restores its record too.

The first Publish live after the update records the `baseline`: every page
that was live already, dated as the sitemap dated it until then
(`pages.updated_at`, never before the page went live). Baseline rows are never
announced, because IndexNow asks not to submit changes from before it was set
up.

What plugins bake into a page (`staticRender`: approved comments, the
language switcher) is a second fingerprint next to it, `plugin_fingerprint`:
the visible content of every plugin region of the finished page. A plugin
renders one region per page wherever its placeholder sits, so all of them
count, header and footer included. Either fingerprint moving is a change.

Plugin content takes a second road live. A Stage bakes it like everything
else. Between Publish lives the plugin-data build (#1155) re-bakes the
regions of the pages a plugin names (a newly approved comment) into the live
files on the scheduler tick. It follows the same rule: it takes the plugin
fingerprint of each re-baked page from its live file, appends a `changed`
row dated when the content went live for every page that moved, brings that
page's `<lastmod>` and feed entry up to date in the live `sitemap.xml` and
`feed.xml` (and, on an article page, its `article:modified_time`,
docs/dev/seo-head.md), and announces it like a Publish live, inside the
tick's request.
The entry's title and summary are the published ones the record holds,
never page rows nobody published. When several production targets serve
the same build, each target's copy gets the same entries. Those are the only bytes it writes besides the
regions (`search_feed.plan_plugin_data`, `applyPluginDataChanges`).

An incremental build renders only the pages a change reached. It records
their changes and takes the other pages' dates, titles and summaries from
the record (each row stores the title and meta description the page was
published with), never from page rows that may hold unpublished edits. It cannot
tell which pages were removed.

## The feed

`/feed.xml` lists the 100 pages that changed last, newest first. Each entry
carries `urn:uuid:<page id>` (permanent across URL changes), the canonical URL
(made absolute against the site address when an override is relative),
`published` (first publication) and `updated` (the change date), and the meta
description as the summary. The feed is titled with the site's host. A build
always knows the host, so the feed never waits for authoring data. It names
Google's hub (`https://pubsubhubbub.appspot.com/`) as `rel="hub"`.

Every page links it (`<link rel="alternate" type="application/atom+xml">`,
also in the editor preview), and robots.txt lists it as a second `Sitemap:`
line, since search engines accept Atom as a sitemap of the latest URLs.
Staging's robots.txt lists nothing. On GCS the feed is served `no-cache`, so the
hub's fetch right after the ping never gets a copy a cache took before the
publish.

## The pings

The run's transaction queues one row per channel in
`search_engine_notifications`:

- **WebSub** when the feed changed: an announced page, or a feed this
  production run serves for the first time. A newer ping makes the older ones
  still waiting `skipped`, because the hub fetches the feed as it is when the
  ping arrives. A late answer for such a ping leaves it `skipped`, unless the
  ping did go out.
- **IndexNow** when the run announces pages and serves a key: every URL that
  changed, plus the URL a moved or removed page was live at before. The URLs
  are grouped by host (a submission names one host whose root serves the key
  file), at most 10,000 per request.

They are sent right after the commit, inside the request that published.
Publish live, a production build and a rollback all wait for the send (at most
10 seconds per request). An answer of 2xx is `sent`. 429, 5xx and no answer
are retried by the tick with backoff (2, 4, 8 … minutes, at least the
engine's `Retry-After`) up to 6 attempts. Any other 4xx is refused for good
(for example a key file the engine could not read). With several
submissions (one per host), a passing error retries the notification; else
one accepted submission makes it `sent`, with the refused hosts named in its
detail; else it is `failed`. An address that is not absolute is left out and
named. A notification the sender cannot even build is recorded `failed`,
so it never blocks the others. A send never fails or delays the publish
beyond the request.

The row is `skipped`, with the reason, when the site's address cannot be
reached from the internet (localhost, `.local`, `.test`, an IP address and the
like: `isPublicSiteHost`), and on installs with `CAELO_SEARCH_NOTIFY=off`. The
switch is checked again when sending, so turning it off also marks the queued
retries `skipped` instead of sending them. Test runs set it (`scripts/test-preload.ts`, the Playwright config, the scale
gate). The sender's own tests pass a fake `fetch`.

Nothing here builds or publishes: the tick's task only announces what a human
Publish live already put live (CLAUDE.md §2).
