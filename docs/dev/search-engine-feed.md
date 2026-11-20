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

A page's date moves when what the page itself shows changes: its title, its
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
  at that run's head (`deploy_runs.live_versions_head`), dated with the
  rollback, because live content changed at that moment. A build from before
  the record began has no state to restore. Then nothing is appended until
  the next Publish live.

The first Publish live after the update records the `baseline`: every page
that was live already, dated as the sitemap dated it until then
(`pages.updated_at`, never before the page went live). Baseline rows are never
announced, because IndexNow asks not to submit changes from before it was set
up.

An incremental build renders only the pages a change reached. It records
their changes and takes the other pages' dates from the record. It cannot
tell which pages were removed.

## The feed

`/feed.xml` lists the 100 pages that changed last, newest first. Each entry
carries `urn:uuid:<page id>` (permanent across URL changes), the canonical URL,
`published` (first publication) and `updated` (the change date), and the meta
description as the summary. The feed is titled with the site's host. A build
always knows the host, so the feed never waits for authoring data. It names
Google's hub (`https://pubsubhubbub.appspot.com/`) as `rel="hub"`.

Every page links it (`<link rel="alternate" type="application/atom+xml">`,
also in the editor preview), and robots.txt lists it as a second `Sitemap:`
line, since search engines accept Atom as a sitemap of the latest URLs.
Staging's robots.txt lists nothing. On GCS the feed is cached for 60 seconds
only, so the hub's fetch right after the ping gets the new copy.

## The pings

The run's transaction queues one row per channel in
`search_engine_notifications`:

- **WebSub** when the feed changed: an announced page, or a feed this
  production run serves for the first time. A newer ping makes the older ones
  still waiting `skipped`, because the hub fetches the feed as it is when the
  ping arrives.
- **IndexNow** when the run announces pages and serves a key: every URL that
  changed, plus the URL a moved or removed page was live at before. The URLs
  are grouped by host (a submission names one host whose root serves the key
  file), at most 10,000 per request.

They are sent right after the commit, inside the request that published.
Publish live, a production build and a rollback all wait for the send (at most
10 seconds per request). An answer of 2xx is `sent`. 429, 5xx and no answer
are retried by the tick with backoff (2, 4, 8 … minutes, at least the
engine's `Retry-After`) up to 6 attempts. Any other 4xx is `failed`: the
engine refuses the request as it is (for example a key file it could not
read). A send never fails or delays the publish beyond the request.

The row is `skipped`, with the reason, when the site's address cannot be
reached from the internet (localhost, `.local`, `.test`, an IP address and the
like: `isPublicSiteHost`), and on installs with `CAELO_SEARCH_NOTIFY=off`. Test
runs set that (`scripts/test-preload.ts`, the Playwright config, the scale
gate). The sender's own tests pass a fake `fetch`.

Nothing here builds or publishes: the tick's task only announces what a human
Publish live already put live (CLAUDE.md §2).
