---
path: /docs/error-pages/
title: "Error pages (404)"
description: "How your site answers a URL that does not exist — with status 404 and its own 404 page in the site's design."
---

# Error pages (404)

When a visitor opens a URL that does not exist (an old bookmark, a typo, a removed page), Caelo answers with **HTTP status 404** and the site's own **404 page**: an ordinary page in the site's design, with its header, footer, theme and self-hosted fonts.

## Setting it up

Ask the AI in the editor chat, for example *"make a page for broken links"*. The AI builds a normal page with the site's template (for example a short "Page not found" message with links back to the homepage and the main sections), publishes it, and makes it the site's 404 page.

Until a 404 page is set, the AI offers to make one at the end of a turn. It does not build the page unasked in the middle of another request (a "build me a homepage" turn stays a homepage turn); say yes and it sets the page up. One site has exactly one 404 page; making another page the 404 page replaces it, and you can ask the AI to remove the setting. The homepage cannot be the 404 page.

## What gets published

- The 404 page is rendered like every other page and published as **`/404.html`**. It is **not** published at its own address as well: a second copy answering with status 200 would be a "soft 404" that search engines index.
- `/404.html` is marked `noindex`, has no canonical URL, and is never listed in `sitemap.xml`.
- It renders correctly at any depth, for `/x` as well as `/a/b/c/x`.
- If a 404 page is set but not published (still a draft, or deleted), Stage and Publish live **stop** with a message naming the fix. If no 404 page is set, the site ships none and the hosting provider's generic error page answers instead.

## Per hosting setup

| Install | How `/404.html` is served | Status |
|---|---|---|
| Google Cloud with Firebase Hosting (`gcp-firebase`) | Firebase serves `/404.html` for every unknown path | 404 |
| Google Cloud with load balancer + Cloud CDN (`gcp`) | the site bucket's `notFoundPage` | 404 |
| Self-hosted (Caddy) | Caddy rewrites every 404 to `/404.html` | 404 |

Other error statuses (5xx) come from the hosting provider or CDN itself; the published site is static and runs no code that could render them.

## Languages

A site has one 404 page. Sites with several languages (international-site plugin) currently serve that one page for unknown URLs in every language, still with status 404; per-language 404 pages are tracked in [#802](https://github.com/caelo-cms/caelo-cms/issues/802).
