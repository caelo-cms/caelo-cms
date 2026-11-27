# Removed pages: 410 Gone

Issue #1762 (epic #1751). A page deleted on purpose, with no page that takes its place, can leave a **410 Gone** rule at its address. Search engines drop a 410 sooner than a 404, and nobody mistakes it for a broken link.

## How a page gets one

`pages.delete` / `pages.delete_many` (AI tool `delete_pages_many`) take `disposition: "410"` beside `"404"` and `"redirect"` (`packages/admin-core/src/ops/content/page-gone.ts`):

- The rule is a row of the redirects table with status 410, written like the delete's 301 (#1550): an automatic change of origin `page_delete`, Staged, live with the Publish live that ships the delete, taken back by the chat's Undo. Its stored target (`/`) is never served; the redirect plan reads only its from path (`buildRedirectPlan`, `gone` entries).
- **A removed page that already has a redirect keeps it.** When the address has a live rule, or a pending change that is not a removal, the delete writes no 410 and reports the rule it kept (`keptRedirects`; the tool lists them). Turning a 301 into a 410 would strand every link that followed it.
- The home page's address cannot be gone: the delete is refused and names the way out (another home first, or `404` / `redirect`).
- A page only a chat's branch holds was never public, so it gets no rule, as for the 301.

Links to the removed address are found by the Stage's `links` check (a redirect chain ending at a gone path).

## What each hosting provider answers

No compute on the static request path (CLAUDE.md §11.B Tier 1): a provider answers 410 only where its edge can send a bare status from configuration. Elsewhere the gone address answers the 404 every path without a file gets, and the AI and Settings → Redirects say so (`goneStatusOnProvider`, `_redirect-sync-note.ts`).

| Provider | Serving layer | Answer for a gone address | How |
|---|---|---|---|
| self-hosted | Caddy | **410** | the redirects snippet's `map` marks the path, `respond 410` (`redirect-emit-caddy.ts`) |
| aws | CloudFront | **410** | the CloudFront Function that already serves the redirect table answers `{ s: 410 }` from its KeyValueStore (`redirect-emit-cloudfront.ts`); no extra compute |
| gcp | Cloud Storage behind the global external Application Load Balancer, Cloud CDN | 404 | a URL-map `urlRedirect` sends only 3xx. The URL map's custom error response policy could turn the bucket's 404 into a 410 per path rule; it is not wired yet (verifying it needs a live load balancer), tracked with the other per-status pages in #1018 |
| gcp-firebase | Firebase Hosting | 404 | `redirects` take 301/302 only, `headers` cannot change a status, and a `rewrite` to Cloud Run would put compute on every such request |
| azure | Blob Storage behind Front Door | 404 | Front Door's rules engine redirects (301/302/307/308) and rewrites, and has no fixed-status action; Azure's adapter is not complete (#750) |

A 404 drops out of search too, only more slowly; the plan answers it with the site's 404 page where one is designated (#802).

## Tests

- `packages/admin-core/src/__tests__/delete-pages-disposition.integration.test.ts`: the Staged 410 rule, a kept live and a kept pending redirect, the home page refused.
- `packages/shared/src/redirect-emit.test.ts`, `redirect-plan.test.ts`: 410 rows as `gone` entries and their Caddy and CloudFront output.
