---
slug: visitor-privacy
template: doc-page
status: published
seo:
  title: Visitor cookies and consent — Caelo CMS
  description: Which cookies a Caelo site sets on its visitors, which need consent, and what "reject all" in the consent banner turns off — including the caelo_visitor_id cookie.
---

# Visitor cookies and consent

A published Caelo site is static files. Cookies only come into play when a visitor uses something interactive — a form, a comment, a rating, a login, the consent banner itself — and the request goes to the API gateway.

The rule Caelo follows: **a cookie that is not strictly necessary for what the visitor asked for is only set after the visitor agreed to it** (TTDSG §25 / ePrivacy Art. 5(3)). If a visitor clicks "reject all", nothing that recognises them is stored in their browser.

## The cookies

| Cookie | Set by | Category | Lifetime | What it is for |
|---|---|---|---|---|
| `caelo_consent` | The consent banner (consent-manager plugin), in the browser | Necessary | 1 year | Remembers the visitor's choice so the banner is not shown on every page. |
| `caelo_session` | The API gateway, only when a visitor logs in (auth plugin) | Necessary | The login session | Keeps a logged-in visitor logged in. Only exists after they log in. |
| `caelo_visitor_id` | The API gateway | **Analytics — needs consent** | 30 days | Recognises the same browser across requests: which form submissions, votes and gateway requests came from one browser, and a per-browser rate-limit budget. |

## `caelo_visitor_id` needs analytics consent

The gateway sets `caelo_visitor_id` only when the visitor's current choice in the consent banner includes **Analytics**:

- **No choice yet** — no cookie. A first-time visitor is not recognised.
- **"Reject all"**, or a choice without Analytics — no cookie, also not on the request that records the rejection.
- **Accepted Analytics** — the cookie is set on the next request to the gateway (usually the one that records the choice).
- **Withdrawn later** — the next gateway request deletes the cookie. The cookie is `HttpOnly`, so the page's script cannot remove it itself; the gateway does, on the request that records the new choice.
- **The privacy policy version changed** (an Owner asked to re-ask everyone) — an older choice no longer counts, so the cookie is deleted until the visitor answers again.
- **No consent banner on the site** (the consent-manager plugin is not active) — nobody can have agreed, so the cookie is never set.

The gateway checks this on the server, from the choice the banner stored. A script that calls the gateway directly cannot get the cookie without that choice.

### Why Analytics, not Necessary or Functional

Nothing a visitor asks for depends on it: forms, comments, ratings, logins and the anti-spam check all work without it. That rules out **Necessary**. It does not remember a preference the visitor set, so it is not **Functional**. What it does is tie one browser's requests together, which is measuring how the site is used — **Analytics**. Nothing leaves your site and no advertising profile is built, so it is not **Marketing**.

## What works without it

| Feature | Without the visitor id |
|---|---|
| Forms | Submissions arrive as usual; they are just not linked to one browser. |
| Comments | Unchanged. |
| Ratings | Every vote counts as a new one. With the visitor id, a second vote from the same browser replaces the first. Repeat voting is limited by the per-IP rate limit and the anti-spam check instead. |
| Rate limiting | Counted per client IP address. With the visitor id, each browser gets its own budget, which is fairer when many people share one IP (an office, a mobile carrier). |
| Anti-spam (proof of work) | Unchanged — each challenge is single-use. |
| Consent records | The record of a rejection holds no visitor id. A record of an acceptance holds the id that was set with it. |

## If the gateway cannot read the consent settings

When the consent banner plugin is active but its settings cannot be read, the gateway refuses the request (`503 ConsentUnavailable`) instead of guessing what the visitor chose. Guessing "yes" would set a cookie nobody agreed to; guessing "no" would hide that the banner is broken.

## Telling your visitors

Your consent banner lists the categories. Ask the AI to mention `caelo_visitor_id` in the Analytics description — for example "Recognises your browser on return visits (cookie caelo_visitor_id, 30 days)" — and to list the cookies above in your privacy policy.
