# Error pages (404)

When a visitor opens a URL that does not exist (an old bookmark, a typo, a removed page), Caelo answers with **HTTP status 404** and the site's own **404 page**: an ordinary page in the site's design, with its header, footer, theme and self-hosted fonts.

## Setting it up

Ask the AI in the editor chat, for example *"make a page for broken links"*. The AI:

1. builds a normal page with the site's template (`build_page`), e.g. a short "Page not found" message with links back to the homepage and the main sections;
2. publishes it (`set_pages_status_many`);
3. designates it with `set_not_found_page({ pageId })`.

The AI's site status reports "404 page: not designated" until this is done, so the AI usually offers it on its own. One site has exactly one 404 page; designating another page replaces it, and `set_not_found_page({ pageId: null })` removes the designation. The homepage cannot be the 404 page.

## What the build does

- The designated page is rendered like every other page and written to **`/404.html`**. It is **not** published at its own slug: a second copy answering with status 200 would be a soft-404 that search engines index.
- `/404.html` carries `<meta name="robots" content="noindex">`, no canonical URL, no `og:url`, no hreflang, and it is never listed in `sitemap.xml`.
- All asset URLs in the page are root-absolute, so the same file renders correctly for `/x` and for `/a/b/c/x`.
- If a 404 page is designated but not published (still a draft, or deleted), Stage and Publish live **fail** with a message naming the fix. If no page is designated, the build ships no `/404.html` and the hosting provider's generic error page answers instead.

## Per provider

| Provider | How `/404.html` is served | Status |
|---|---|---|
| gcp-firebase (Firebase Hosting) | Firebase serves a root `/404.html` for every unmatched path | 404 |
| gcp (GCS + Load Balancer / Cloud CDN) | bucket website `notFoundPage: "404.html"` | 404 |
| aws (S3 + CloudFront) | CloudFront custom error responses map the S3 origin's 404 **and 403** (a private bucket answers a missing key with 403) to `/404.html` | 404 |
| azure (Blob static website + Front Door) | static website `error404Document: "404.html"` | 404 |
| self-hosted (Caddy) | `handle_errors 404 { rewrite * /404.html; file_server }` | 404 |

Other error statuses (5xx) are produced by the hosting provider or CDN itself; the static site has no compute on the request path that could render them.

## Languages

Core has one 404 page for the whole site. Sites with several languages (international-site plugin) currently serve that one page for unknown URLs in every language, still with status 404; per-language 404 pages are tracked in [#802](https://github.com/caelo-cms/caelo-cms/issues/802).
