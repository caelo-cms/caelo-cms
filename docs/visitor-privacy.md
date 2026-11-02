# Visitor cookies, consent and the API gateway

What a site visitor's browser stores for Caelo, what it sends to the API gateway, and how consent decides what the gateway may store. Read this before you add a cookie, change what the gateway reads from a request, or change the consent-manager runtime. The rules come from CMS_REQUIREMENTS §14 (consent purposes) and issues #677 (visitor id only with consent) and #1343 (one cookie on every provider).

## The two things that reach the gateway

Firebase Hosting forwards exactly one cookie over its `/api/**` rewrite: `__session` ([dev/firebase-hosting-behaviour.md](./dev/firebase-hosting-behaviour.md), section 1). Every other cookie is set in the browser and never comes back. So the gateway reads only:

1. **The `__session` cookie**, set by the gateway itself: HttpOnly, SameSite=Lax, Secure in production, Path=/.
2. **The `x-caelo-consent` request header**, the visitor's consent decision.

This holds on every provider (gcp, gcp-firebase, aws, azure, self-hosted), not only behind Firebase: one shape, no provider-specific path in the gateway (CLAUDE.md §11.B).

## `__session`: one cookie, several entries

`__session` is a container (`packages/shared/src/session-cookie.ts`). Its value is a URI-encoded `URLSearchParams` string with one parameter per entry, `<key>=<expiresAt>.<value>`:

| Entry | Owner | Holds | Set when | Lifetime |
|---|---|---|---|---|
| `vid` | gateway | the visitor id, HMAC-signed | an active plugin declares the `visitor_id` purpose AND the decision grants its category | 30 days from when it was set |
| `login` | gateway | the visitor's login session token (auth plugin), HMAC-signed | the auth plugin calls `setSession` | the session's expiry, at most 30 days |
| `staging` | staging gate | reserved for the staging gate's session (E13 (a), #763) | not used yet | the gate's |

Rules for anyone who writes the cookie:

- Keep every entry you received and did not mean to change. Entries of different owners share the cookie, so dropping one you do not own logs a visitor out or loses their staging access.
- Every value carries its own integrity check, made and checked by its owner. The container is not signed: `expiresAt` only sets the browser's Max-Age and lets the reader drop an entry early, which a client could do anyway.
- The cookie's Max-Age follows its longest-lived entry. When no entry is left the cookie is expired.

The gateway's side is `apps/api-gateway/src/gateway-cookies.ts`. It writes the cookie only when one of its entries changed in that request, so most responses carry no `Set-Cookie`. Two requests in flight at once can still race: each writes the container it read plus its own change, and the later response wins. That needs a login and a first visitor-id mint at the same moment, and costs either the new id (minted again on the next call) or the new login.

## The consent decision travels as a header

The consent-manager's banner keeps the visitor's choice in its own first-party cookie, `caelo_consent`, because its runtime has to read the choice back before anything on the page loads. That cookie never reaches the gateway behind Firebase Hosting, so the gateway no longer reads it at all. Instead:

- The runtime exposes the current decision as `window.caeloConsent.decisionHeader()`: `v=<policyVersion>; granted=<key>,<key>`, or `null` when there is no current decision (none yet, an older policy version, or a category offered since). It carries nothing else: the consent id and timestamps stay in the cookie.
- The runtime sends that header on its own `record_consent` call (a keepalive `fetch`; `sendBeacon` cannot carry a header), so a withdrawal reaches the gateway on that very call.
- The component kit (`packages/plugin-component-kit`) sends it on every gateway call it makes: `postPluginJson` and `attachCaptchaProof`. A plugin component that calls the gateway with its own `fetch` sends no decision, and the gateway treats the call as "no decision" (below).
- The gateway parses the header (`parseVisitorConsentHeader`, `packages/plugin-host/src/visitor-consent.ts`) and checks it against the consent provider's rule (`visitor_consent_rule`: the current policy version and the category of each declared purpose).

The header is no weaker than the cookie it replaces: both are written by the page's own script and neither is more than the visitor's say-so. A cross-site page cannot set the header at all, because a custom header needs a CORS preflight the gateway never grants.

## What the gateway does with the visitor id

Everything that is not an unambiguous yes is a no (#677). The gateway stores, reads and hands a plugin the visitor id only when all of these hold:

- an active plugin declares the `visitor_id` purpose (today: ratings, under `functional`);
- a consent provider runs on the site;
- the request's `x-caelo-consent` header grants that purpose's category under the current policy version.

Otherwise it neither uses the id nor keeps it: it removes the `vid` entry in the same response. That is how a withdrawal reaches the HttpOnly cookie, which the page's script cannot change. A call without the header counts as no decision too. The id reaches only the plugin that declared the purpose, never every plugin on the site. Rate limits and captcha proofs never use it.

For the banner and the privacy policy a plugin names the cookie its purpose uses: the `visitor_id` purpose must name `__session` (plugin SDK `VISITOR_ID_COOKIE`). `caelo_*` cookies and `__session` are host-owned, so no other purpose may name them.

## Cookies from before #1343

Until #1343 the gateway set `caelo_visitor_id` and `caelo_session`. It never reads them again:

- **Consent is unchanged.** `caelo_consent` did not move, so no visitor is asked again and the banner shows their choice as before.
- **Visitor id:** a consented visitor gets a new id on their next gateway call. For ratings that means one more vote can count as new instead of replacing the earlier one.
- **Visitor login:** a logged-in visitor logs in once more.

The gateway expires `caelo_visitor_id` whenever it arrives, so an id set under an old consent does not stay on a device after the visitor withdrew it. It expires `caelo_session` only when the value carries the gateway's own signature: the admin's session cookie has the same name, and on a host the two share (local development) expiring it would log an editor out. This expiry is deleted once every release that set the old cookies is older than 30 days (#1353).

## Tests

- `packages/shared/src/session-cookie.test.ts`: the container format.
- `packages/plugin-host/src/visitor-consent.test.ts`: parsing the header and the consent rule.
- `apps/api-gateway/src/visitor.test.ts`: every consent state, entry handling, legacy cookies.
- `apps/api-gateway/src/visitor-consent.integration.test.ts`: the real consent-manager and ratings plugins, including a browser behind a proxy that forwards only `__session`.
- `apps/api-gateway/src/server.integration.test.ts`: a visitor login surviving that proxy.
- `apps/admin/e2e/consent-visitor-cookie.browser.ts`: Chromium against a generated site, straight to the gateway and through a simulated Firebase rewrite (`CONSENT_SITE_FIREBASE_REWRITE=1` in `apps/api-gateway/e2e/consent-site.ts`).
