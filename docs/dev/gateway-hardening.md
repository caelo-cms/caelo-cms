# Gateway hardening without a WAF

The cheap setup (gcp-firebase) has no load balancer and no WAF in front of the API gateway, and the gateway stays reachable on `*.run.app` (epic #763, decision E3). So every protection lives in the gateway and in the database itself. Where a provider has a WAF (gcp: Cloud Armor), it is an extra layer, never the only one. This page describes the gateway's own layers from #1326 (P1) and #1338 (P8).

## A gateway whose feature is off (E14 a, #1339)

Every public service is provisioned on every install at zero minimum instances, so one that nobody uses costs nothing. While its feature is off it answers the fixed 404 of a path that names no route (`{ ok: false, error: { kind: "NotFound", requestId } }`, no cookie), before it reads the request and before any database access:

| Service | Off while | Still answers |
|---|---|---|
| live gateway | no active plugin serves an operation to visitors (`publicOperations`) | `/healthz`, `/api/_caelo/health` (the upgrade's check) |
| staging gateway | no staging host is set (`published_staging_site.staging_host` is NULL) | `/healthz` |
| MCP-Auth-Proxy | remote MCP is unavailable on the provider or not set up ([public-admin-boundary.md](./public-admin-boundary.md)) | its health check |

The gateways know it from published state they hold in memory while the published-state LISTEN holds (below): after the admin's publish notification the next request reads the registry or the staging row once (behind the in-memory limiter), and every request after it is answered from memory. A read that failed, or that a newer notification overtook, decides nothing: the request takes the full pipeline (plugin-host `servesVisitorOperations`, api-gateway `featureOff`). So the Owner activating a visitor-facing plugin turns the live gateway on with no redeploy. Creating and removing the services from Settings → Updates (E14 b) comes later.

## Cached published state on request-billed CPU (#1361)

The gateways run with CPU only while they serve a request (Cloud Run `cpuIdle`). A publish notification that arrives between requests waits in the socket until CPU comes back with the next request, and that request could read a cache the notification drops before the LISTEN callback runs: a closed staging gate, a revoked plugin, a rotated cookie secret. So a request that starts while no other request is in flight marks the published state unconfirmed (`servePublishedRequest`, `published-changes.ts`). The first request that then reads it confirms it (`confirmPublishedState`). It reads the projection's section versions once: every publish rewrites the `published_projection_sections` rows of the sections it published in the transaction that notifies, so their `xmin` values change. When they differ from the last confirmation, every cache is dropped, as the notification will drop them. Requests that confirm together share one read, and a read that fails drops the caches, so the request reads through and the next one tries again.

The confirmation comes after the cheap gates, right before the read that decides the answer, so junk never reaches it: on the visitor routes after the route filter and the per-client in-memory budget (step 2 above), on the staging gateway after the gate's failure budget. The one exception is the first request after a notification on the live gateway. It reads the registry anyway, to learn whether the feature is off, before anything of the request is read (E14 a), and it confirms right before that read. While requests keep coming the instance had CPU throughout and its notifications were handled, so it confirms again only once the last confirmation is older than 30 s (`CONFIRM_MAX_AGE_MS`); that also bounds what a LISTEN connection that died without a word could hide. A gateway whose feature is known to be off answers from memory too (E14 a), and that answer comes before every gate, so it is confirmed on its own terms (`confirmOffAnswer`): at most once per 30 s, whether or not the instance idled. Junk on an off gateway costs at most one read per 30 s, and an instance that idled longer than that serves a feature switched on meanwhile (a staging host set, a visitor plugin activated) from its first request. Only a request within 30 s of the last confirmation can get the fixed 404 once more while the notification turning the feature on still waits.

## Order of a visitor request

`apps/api-gateway/src/server.ts` checks, in this order, and stops at the first refusal:

| Step | What | Database? | Answer |
|---|---|---|---|
| 1 | Route: `GET /api/captcha/challenge` or `POST /api/plugin/<slug>/<op>` with slug ≤ 64 and op ≤ 120 characters (`middleware/plugin-request-filter.ts`). The remote-MCP routes and health are routed before this and keep their own rules. | no | 404 `NotFound` |
| 2 | Per-client in-memory budget (`middleware/memory-limiter.ts`, `VISITOR_MEMORY_LIMIT`: burst 120, then 2/s, keyed by the client's rate-limit address). | no | 429 `RateLimited` |
| 3 | Settings and live origins, read from the projection (cached while the LISTEN holds). | read | 503 when not published |
| 4 | Plugin POSTs only: `Content-Type: application/json`, and `Origin` one of the live site origins. | no | 415 / 403 |
| 5 | The operation must be one an active plugin serves to visitors (`publicOperations`), from the registry the admin published (synced at most every 5 s). | read | 404 `NotFound`, nothing written |
| 6 | Per-operation in-memory budget, whoever calls it (`OPERATION_MEMORY_LIMIT`: burst 300, then 5/s per instance). | no | 429 `RateLimited` |
| 7 | Body cap, visitor and consent, honeypot, the database rate limit, captcha, dispatch, request log. | write | as before |

An invented slug or operation therefore never creates a rate-limit bucket, a request-log row or a cached spec: the database rate limit is resolved only for an operation that exists, and the honeypot's bucket is applied (once spent, the bot gets a 429).

### Why a per-operation budget

On gcp-firebase the only `X-Forwarded-For` entry nobody can forge is the one Cloud Run appends, and that is a Google front-end proxy that changes per request (measured in #1325, [firebase-hosting-behaviour.md](./firebase-hosting-behaviour.md)). Per-client buckets there are close to one bucket per request. The per-operation budget is what bounds a flood from many addresses. It is per instance; Cloud Run runs at most `gatewayMaxInstances` of them.

## The edge per provider (E3, #1339)

No protection on this page depends on a WAF. Where a provider has one it is an extra layer; `packages/provisioning/src/public-service-shape.ts` is the per-provider table (E11), and `public-service-shape.test.ts` pins every stack, the CLI setup modules, the Compose file and the GCP cost table to it.

- **gcp-firebase (the cheap setup):** no load balancer, no WAF. The gateways and the MCP-Auth-Proxy are publicly invokable on their run.app URLs (the Firebase rewrites need it), so everything here is the protection.
- **gcp:** the gateway's Cloud Armor policy, shared by the staging gateway's backend, has per-path rules (`packages/provisioning/src/gateway-edge.ts`; the converge applies them to existing installs, infrastructure contract 22):

  | Priority | Matches | Rule |
  |---|---|---|
  | 800 | `^/api/plugin/auth/(signup\|login\|request_password_reset\|reset_password)$` | ban an IP for 10 min above 30 a minute |
  | 810 | `/api/captcha/challenge` | throttle (429) above 60 a minute |
  | 1001 | any path containing `/api/` | ban an IP for 10 min above 100 a minute (replaces the old catch-all at 1000, which the converge deletes only after the new rules are in) |
  | 2000, 2001 | OWASP sqli / xss, sensitivity 1 | deny (403) |

  The general ban used to match every request; staged pages share the policy since #1330, so a reviewer who browsed a few of them was banned from staging. Sensitivity 1 keeps the OWASP packs from flagging ordinary comment and form text.
- **self-hosted:** Caddy caps request bodies bound for a gateway at the gateways' hard ceiling (`HARD_MAX_BODY_BYTES`, 1 MiB) and has no rate limit of its own: stock Caddy has no `rate_limit` directive. Caddy hands the gateways the real client address (one trusted hop), so their per-client limits work there.
- **aws, azure:** the database passwords are secret references (Secrets Manager entries for the task definitions of #749; Key Vault references through one identity per reader on azure), never part of a database URL. The rest of the shape comes with #749 / #750.

## Live origins

The admin publishes `published_gateway_settings.live_origins` (cms_public 0500) from the site's base URL and every public domain of the domains registry (`liveSiteOrigins` in `packages/migrations/src/public-projection.ts`). The staging host is never one of them: staging is same-site with live, so `SameSite` cookies and `Sec-Fetch-Site` do not stop it, and unreviewed module JS on staging must not post into live data (#763 N4). Triggers on `site_defaults.site_base_url`, `domains` and `staging_access.staging_host` republish the list (cms_admin 0500).

A request without `Origin` is refused: every browser sends it on a POST. NULL (an older admin published the row) and an empty list are a 503 whose log line names the fix.

The staging gateway publishes the staging origin as its own `live_origins` (`stagingSiteOrigins`), so staged pages post to staging data and never to live, and a live page never posts into staging data. The quality audit's loopback copy of a staged build (`admin-core quality/staged-origin.ts`) still answers plugin calls with HTTP 200 `{ ok: false, error: { kind: "StagingPreview" } }` (`@caelo-cms/shared` `staging-plugin-stub.ts`): an audit writes no visitor data anywhere, and a failed request would count as a page error.

## The staging gateway (#1330, #1331)

Staging is served by its own gateway: the same image, `CAELO_GATEWAY_ENVIRONMENT=staging`, its own database `cms_public_staging` as `public_staging_role` (below), and `CAELO_STAGING_STORAGE` naming the private staging storage it reads (`gs://<staging bucket>` on gcp and gcp-firebase, `file:///srv/staging`, the staging output directory mounted read-only, on self-hosted). `apps/api-gateway/src/staging/site.ts` answers every request:

| Step | What |
|---|---|
| 1 | `/healthz` is the only path without the gate (the server routes it first). |
| 2 | `/_caelo/staging-access?t=…` turns an "Open staging" token into the `staging` entry of the `__session` cookie (the one cookie Firebase Hosting forwards, #1325). `/_caelo/staging-check?location=…` answers the admin's serve check, with a per-run `check` token only. |
| 3 | A client whose gate failures used up its budget (`GATE_FAILURE_LIMIT`: 30, then one per 10 s) gets a 429 before any HMAC (DoS only). |
| 4 | The #650 gate: session entry, basic auth, secret header, IP allowlist, or a per-run token of the admin's capture and serve checks. The host plays no part, so `*.run.app` gets the same gate as the staging host. The IP allowlist is never matched on gcp-firebase (no trustworthy client address behind the rewrite; the admin refuses to save one there). |
| 5 | Admitted `/api/*` takes the visitor routes of this gateway (its own database). |
| 6 | Admitted GET/HEAD: the published redirects table (the live page wins; a gone row answers what the live provider answers), then the file from the served build's manifest, then its `404.html`. |

Files stream from staging storage. Only paths the manifest lists are read, so a request cannot name a storage key outside the served location. Every build renders the live host (Publish live is a copy, #1003), so text types are piped through `originRewriteStream` (`@caelo-cms/shared` staged-site.ts), which replaces the live origin (and its JSON-escaped form, whole origins only) with the staging host while it streams. Every answer carries `X-Robots-Tag: noindex` and `Cache-Control: private, no-store`. A file that does not start within 45 s is a 504 (Firebase replays a GET that has not answered after 60 s up to eight times).

What the staging gateway reads comes through its projection (`published_staging_site`, cms_public 0600, written into cms_public_staging only): the gate settings, the gate key (#1331: it moved there from the gateways' env, never re-minted, so crawler credentials keep working; the live gateway holds no gate key any more), the served run, its location and the origin it was rendered for. The row is an upsert: the migration job, which does not hold the key, leaves the published key as it is.

### Staging storage and the A/B slots

Staging storage always holds complete builds (decision 2026-11-04 on #1330). On gcp and gcp-firebase it has two slots, `_slots/a` and `_slots/b`, each with its manifest next to it (`_slots/a.manifest.json`: run, page URL style, every file with its type and a hash). A Stage takes the staging publish slot before its upload opens, fills the slot staging does not serve and records it as served in the transaction that records the run (`staging_access.served_location`, cms_admin 0600); the drain then points the staging gateway at it. The sync compares hashes with the slot's manifest, writes only what changed, deletes what the build lost and writes the manifest last; it deletes the manifest first, so a sync that stopped halfway makes the next one write everything again (`admin-core deploy/staging-slots.ts`). gcp fills a slot with server-side copies (from the run's prefix and the live bucket); gcp-firebase uploads the files that differ while the generator streams them (Hosting files cannot be read back). Self-hosted serves the run's build directory (`builds/<runId>` with `builds/<runId>.manifest.json`). The Firebase Hosting version a Stage creates is finalized and released nowhere; Publish live releases a copy of it.

Lighthouse never measures through the gateway (#875): the audit loads the slot on a loopback origin. Captures of the staging host (`screenshot_external_page`, …) get a per-run `capture` token (`admin-core capture/staging-access.ts`), which the browser sends only to the staging origin and never across a redirect off it.

## Errors and headers

A visitor's error is `{ ok: false, error: { kind, requestId } }` and nothing more. The details (an exception's text, a plugin's message, the readiness reason, the limits) go to the log as `[api-gateway] request <requestId>: <kind> — <details>`, and the response carries `X-Request-Id`. Plugin components fall back to their own generic text.

Every JSON response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin` (`middleware/security-headers.ts`), including the staging gateway's and the MCP router's JSON.

`/api/_caelo/health` reports no release version (the upgrade's deep check verifies the gateway's database login; which release runs is established by the roll itself, `packages/provisioning/src/upgrade/health.ts`). `?deep=1` is throttled per client before its database round trip.

`Bun.serve` gets an explicit `maxRequestBodySize` (the larger of the visitor hard cap and the MCP proxy cap), instead of Bun's 128 MB default.

## Client addresses and keyed hashes

`rateLimitAddress` (`client-ip.ts`) reduces an IPv6 address to its /64 (a subscriber chooses freely inside it) and an IPv4-mapped address to the IPv4 address. Both limiters and the database buckets use it.

The database bucket keys are `HMAC-SHA256(key, address)`, never a plain SHA-256 (an IPv4 hash is reversed by trying all 2^32 addresses). The key is per UTC day, in `cms_public.gateway_ip_hash_keys` (`ip-hash-key.ts`): the first instance mints it, every instance reads the same one, so their buckets agree. RLS lets the gateway mint only today's or tomorrow's key and delete only keys whose day ended two days ago; the GC does so. At midnight UTC every bucket starts over once.

## Database limits on public_role

| Setting | Value | Why |
|---|---|---|
| `CONNECTION LIMIT` | 30 | 10 instances × (pool 2 + 1 LISTEN), the gateway's share of the [connection budget](./connection-budget.md); `computePoolBudget` refuses a larger `gatewayMaxInstances` |
| `statement_timeout` | 5s | no visitor request needs longer; bounds a hot bucket's advisory-lock wait |
| `idle_in_transaction_session_timeout` | 15s | an open transaction cannot hold locks or a connection |
| `work_mem` | 1MB | × 30 connections stays inside a db-f1-micro |

Cloud SQL gets them from cms_admin migration 0500 (the migration role may alter `public_role` there); local, CI and self-hosted databases from `packages/migrations/src/bootstrap.sh`, which the self-hosted upgrade re-runs. The role audit (`packages/migrations/src/role-audit.ts`, `PUBLIC_ROLE_LIMITS`) fails the migration run while one is missing.

The staging gateway's `public_staging_role` carries the same four values (#1329, cms_admin migration 0530 on Cloud SQL, bootstrap.sh and `self-hosted-roles.ts` elsewhere), and the role audit checks both logins.

## The staging database (#1329)

Staging has data of its own: `cms_public_staging`, on the same server as the other two databases, reached by the staging gateway as `public_staging_role` (epic #763 E10).

- **One schema, two databases.** `migrate.ts public-staging` runs the cms_public migration files on it, with every whole-word `public_role` retargeted to `public_staging_role` (runner.ts `retargetVisitorRole`): GRANTs, `TO public_role` policies and role checks alike. After each run the role audit proves neither public database grants anything to the other environment's login (`assertPublicDatabaseOwnsItsLogin`).
- **Crosswise isolation, enforced by Postgres.** `public_role` has no CONNECT on cms_public_staging, `public_staging_role` none on cms_public or cms_admin, and PUBLIC none on any of the three (cms_admin migration 0530, bootstrap.sh, `self-hosted-roles.ts`; the role audit refuses anything else). `staging-isolation.integration.test.ts` connects as each login and tries.
- **Each gateway knows which one it is.** `CAELO_GATEWAY_ENVIRONMENT=live|staging` is required: the gateway refuses to boot without it, with a URL for the other environment's database or role, or with any env value or secret file naming them (`database-env.ts`). Every adapter sets `live` on today's gateway.
- **Plugin tables in both.** Every load of a plugin provisions its public tables in cms_public, then in cms_public_staging (plugin-host `public-schemas.ts`), each with the GRANTs of its kind for that database's own login. The two databases share no transaction; because every load re-provisions idempotently, the admin's boot is the repair: it backfills every active plugin's staging tables on an install from before #1329, and finishes a load that stopped between the two. Uninstall drops both.
- **Own credentials.** The staging login's password is its own CLI-generated secret (`public-staging-role-password`), never shared with the live login's; no running service reads it until the staging gateway exists (`SECRETS_SET_UP_AHEAD_OF_THEIR_READER`). The admin reaches the staging database as admin_role (`PUBLIC_STAGING_ADMIN_DATABASE_URL`, a public-only adapter with a fixed pool of 2) and refuses to start without it.
- **Two-target projection.** Every publish writes both public databases; the plugin registry and plugin rows are frozen per Stage and promoted by Publish live (and a rollback), the rest is published at once ([public-admin-boundary.md](./public-admin-boundary.md), "Release sections are frozen per Stage"). Staging gets its own cookie secret, the redirects table (#1157), and its inbox is cleared at every Stage. Team posts (`comment_archive.post_team`) are written as approved under the signed-in user's name and reach both databases like a moderated comment, never through the inbox.
- **Existing installs, no terminal.** The GCP converge (`cms-provision upgrade`, or Install update in Settings → Updates) creates the database and the Admin API user before the migrations (`staging-database.ts`) and revokes the user's Cloud SQL memberships with public_role's (contract 17). Self-hosted upgrades create both as the Postgres superuser before the migrations (`preMigrationRolesScript`), with a password `cms-provision` back-fills into `.caelo/config.json`.

## Fewer writes per request

- Op events (`gateway_plugin_op_events`) are written only for a declared baked-data trigger (`bakedData`, #1155), the one thing the admin reads them for.
- The GC deletes in batches of 1000 rows by primary key, each its own transaction, at most 10 batches per table per sweep; a full batch makes the next request sweep again (`gc.ts`).
