# Gateway hardening without a WAF

The cheap setup (gcp-firebase) has no load balancer and no WAF in front of the API gateway, and the gateway stays reachable on `*.run.app` (epic #763, decision E3). So every protection lives in the gateway and in the database itself. Where a provider has a WAF (gcp: Cloud Armor), it is an extra layer, never the only one. This page describes the gateway's own layers from #1326 (P1) and #1338 (P8).

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

## Live origins

The admin publishes `published_gateway_settings.live_origins` (cms_public 0500) from the site's base URL and every public domain of the domains registry (`liveSiteOrigins` in `packages/migrations/src/public-projection.ts`). The staging host is never one of them: staging is same-site with live, so `SameSite` cookies and `Sec-Fetch-Site` do not stop it, and unreviewed module JS on staging must not post into live data (#763 N4). Triggers on `site_defaults.site_base_url`, `domains` and `staging_access.staging_host` republish the list (cms_admin 0500).

A request without `Origin` is refused: every browser sends it on a POST. NULL (an older admin published the row) and an empty list are a 503 whose log line names the fix.

Interim until staging gets its own gateway (#1329, #1330): a staged page's plugin call never runs against live data (#763 N4), but it must not fail visibly either, or the Stage quality audit would count a "Failed to load resource" console error on every page with a plugin component and block Publish live. So both places it can reach answer it with HTTP 200 `{ ok: false, error: { kind: "StagingPreview" } }` (`@caelo-cms/shared` `staging-plugin-stub.ts`), dispatching and writing nothing:

- the gateway, for a POST whose `Origin` is the published staging host (gcp-firebase and self-hosted, where staging's `/api` reaches the live gateway);
- the audit's loopback origin (`admin-core quality/staged-origin.ts`, gcp / aws / azure), which no longer forwards `/api/plugin/*` to live at all.

Components take their ordinary "no data" path, so plugin data does not show on staging in the meantime. The captcha challenge (a GET, no Origin) is still forwarded and may mint a challenge row in live, bounded by its per-address limit.

## Errors and headers

A visitor's error is `{ ok: false, error: { kind, requestId } }` and nothing more. The details (an exception's text, a plugin's message, the readiness reason, the limits) go to the log as `[api-gateway] request <requestId>: <kind> — <details>`, and the response carries `X-Request-Id`. Plugin components fall back to their own generic text.

Every JSON response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin` (`middleware/security-headers.ts`), including the staging proxy's and the MCP router's JSON.

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

Staging has data of its own: `cms_public_staging`, on the same server as the other two databases, reached by the staging gateway as `public_staging_role` (epic #763 E10; the staging gateway is served from #1330). Converge release 1 of the hardening only adds it; nothing is served from it yet, so a rollback stays harmless.

- **One schema, two databases.** `migrate.ts public-staging` runs the cms_public migration files on it, with every whole-word `public_role` retargeted to `public_staging_role` (runner.ts `retargetVisitorRole`): GRANTs, `TO public_role` policies and role checks alike. After each run the role audit proves neither public database grants anything to the other environment's login (`assertPublicDatabaseOwnsItsLogin`).
- **Crosswise isolation, enforced by Postgres.** `public_role` has no CONNECT on cms_public_staging, `public_staging_role` none on cms_public or cms_admin, and PUBLIC none on any of the three (cms_admin migration 0530, bootstrap.sh, `self-hosted-roles.ts`; the role audit refuses anything else). `staging-isolation.integration.test.ts` connects as each login and tries.
- **Each gateway knows which one it is.** `CAELO_GATEWAY_ENVIRONMENT=live|staging` is required: the gateway refuses to boot without it, with a URL for the other environment's database or role, or with any env value or secret file naming them (`database-env.ts`). Every adapter sets `live` on today's gateway.
- **Plugin tables in both.** Every load of a plugin provisions its public tables in cms_public, then in cms_public_staging (plugin-host `public-schemas.ts`), each with the GRANTs of its kind for that database's own login. The two databases share no transaction; because every load re-provisions idempotently, the admin's boot is the repair: it backfills every active plugin's staging tables on an install from before #1329, and finishes a load that stopped between the two. Uninstall drops both.
- **Own credentials.** The staging login's password is its own CLI-generated secret (`public-staging-role-password`), never shared with the live login's; no running service reads it until the staging gateway exists (`SECRETS_SET_UP_AHEAD_OF_THEIR_READER`). The admin reaches the staging database as admin_role (`PUBLIC_STAGING_ADMIN_DATABASE_URL`, a public-only adapter with a fixed pool of 2) and refuses to start without it.
- **Existing installs, no terminal.** The GCP converge (`cms-provision upgrade`, or Install update in Settings → Updates) creates the database and the Admin API user before the migrations (`staging-database.ts`) and revokes the user's Cloud SQL memberships with public_role's (contract 17). Self-hosted upgrades create both as the Postgres superuser before the migrations (`preMigrationRolesScript`), with a password `cms-provision` back-fills into `.caelo/config.json`.

## Fewer writes per request

- Op events (`gateway_plugin_op_events`) are written only for a declared baked-data trigger (`bakedData`, #1155), the one thing the admin reads them for.
- The GC deletes in batches of 1000 rows by primary key, each its own transaction, at most 10 batches per table per sweep; a full batch makes the next request sweep again (`gc.ts`).
