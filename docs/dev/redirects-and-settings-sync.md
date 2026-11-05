# Redirects and global settings: what goes live how

Decision 2026-10-26 (#1140, #1157): nothing reaches production through a build the Owner did not click, and there is no automatic redeploy (#1154). Page content goes live with Stage + Publish live. Redirects and the global settings that are not tied to a page or template are a separate topic: each one either lives at the hosting provider, and is synced there when it is saved, or renders into the page HTML, and goes live with the next Publish live like page content.

## Redirects sync on save

A redirects write (`redirects.create` / `create_many` / `delete` / `delete_many`, the slug-change and move 301s of `applyPathMoveEffects`, the `international-site` plugin's locale-root redirect) pushes the whole table to the hosting provider right after its transaction commits. No build runs.

Code: `packages/admin-core/src/deploy/redirect-sync.ts` (model, recording), `StaticPublisher.syncRedirects` (one per provider), `redirect-sync-worker.ts` (post-commit runner, save coalescing, retry), ops `redirects.sync_provider` / `redirects.sync_status` (`ops/redirect_sync.ts`), migrations `0378_redirect_sync.sql` and `0457_redirect_sync_off_write_path.sql`.

Nothing of the sync runs on the write path (#1254): a page write never writes or locks the site-wide `redirect_sync_state` rows, and no provider call runs inside any transaction or under any row lock.

1. A write that changes a `redirects` row leaves one insert-only row in `redirect_changes` (row triggers of migration 0457, keyed by the writer's transaction id, so parallel writers never wait on each other). A write that changed no row — a page move that creates no redirect, an upsert of an identical row — leaves nothing and asks for no sync. `requestRedirectSync` only registers a post-commit effect.
2. After the commit the effect runs `redirects.sync_provider` (a detached op, `transaction: "none"`). Saves coalesce per process: one sync runs and at most one waits behind it, so a save that commits during a push is served by the next run, which sees its change. Each run has three steps:
   - **prepare** (one short transaction): fold every visible change row into `wanted_revision` of every target (and delete it; a row of a transaction still running stays for the next sync); claim the publish lease of each environment it pushes (live-release for production, staging-publication for staging, in that order) by the sync's own id (`deploy_leases.holder_sync_id`), never waiting; read the revision, then the table and the build each target serves.
   - **push** (no transaction): the provider's `syncRedirects` per target. The plan is `buildRedirectPlan` computed against the files of the build the target serves now, so a row whose from-path a live page serves is left out (the live page wins). A plan the provider already serves writes nothing (`unchanged`). The claimed lease keeps a Publish live, rollback, Stage or another sync from releasing the same channel meanwhile; it is renewed while the push runs and lapses on the database clock if the instance dies.
   - **record** (one short transaction): the attempt, `synced_revision = GREATEST(synced_revision, revision read)` — a change folded during the push keeps the target behind — and the lease release. If more became due during the push, the run takes another round.

   While someone else holds a lease (a Stage publishing staging #1211, a Publish live or plugin-data build releasing production #1225, a rollback, another instance's sync), that environment is skipped and stays behind; the holder syncs it after its run is recorded (triggers `build`, `publish`, `rollback`) and the worker retries. A save or retry pushes only targets that are behind; a served-build change and the operator's "Try again" push every target they claim.
3. Every attempt is recorded (`redirect_syncs`, audit row `redirects.sync_provider`), and a successful one sets `synced_revision`. A failure leaves the target behind (`wanted_revision > synced_revision`). It shows in Settings → Redirects and in the notification bell, the redirect tools' results say "NOT live yet" with the error, and the worker retries it with backoff (1 minute, doubling, at most 1 hour). The write itself stays a success (it is saved): a page slug change must not report an error because the hosting was unreachable. Settings → Redirects also has "Try again now".
4. Publish live (`deploy.promote`), the plugin-data build and `deploy.rollback` run the same sync for their target after the files are live — Publish live and the plugin-data build in a transaction of their own once their run is recorded (#1225), rollback once its run is recorded (#1254, #1250). The build they ship carries the table as it was when it was staged, and the provider must end up serving the table as it is now.

Per provider:

| Provider | Production | Staging | Rights |
|---|---|---|---|
| `gcp-firebase` | New Hosting version: the live version's files (reused by hash, no upload) and its config with only `config.redirects` replaced (and the `/api/**` rewrite pointed at the current gateway, see below), released on the live channel. | Not on Hosting: the staging gateway answers the redirects table itself, from cms_public_staging (#1330). | `roles/firebasehosting.admin` on the run SA, which Stage and Publish live already use. |
| `gcp` | URL-map redirect rules of the site host's path matcher, against the live bucket's objects (`applyGcpRedirectPlan`). | `not-served`: staging is the admin's staging preview over the staging bucket. It serves no redirects there; the staged plan goes live with Publish live. | `caeloUrlMapRedirects` custom role + live bucket read, which Publish live already uses. |
| self-hosted | `_redirects`, `_redirects.cloudflare` and `_redirects.caddy` rewritten (write-then-rename) in `<out_dir>/current/`, against the files there. The Caddy container's reload loop picks the snippet up within a few seconds (`caddy-redirects.ts`). | The same, in staging's `current/`. | The admin already writes `current/`. |
| `aws`, `azure` | No publisher exists (#749, #750), so nothing is ever published and the sync records `nothing-live`. The stub's `syncRedirects` throws the same NotImplemented as the rest of the stub. | Same. | n/a |

No infrastructure or IAM change, so no stack contract bump.

### gcp-firebase: a cloned version names the current gateway (#1328)

A Hosting version is immutable, so every path that changes what a channel serves without a build creates a new version from the config of one that exists: this redirect sync, the plugin-data release (#1155), Publish live (promote) and rollback. That config carries the `/api/**` Cloud Run rewrite of its day. Contract 16 (#1328) moved the visitor gateway on gcp-firebase from `caelo-<env>-gateway-<suffix>` (now the MCP-Auth-Proxy) to `caelo-<env>-data-gateway` and retired the admin's `run.viewer` on the old service. A verbatim copy then fails, because Hosting checks `run.services.get` on every rewrite target when the version is created ("redirects are saved but do not reach the hosting"), and if it went through it would keep sending visitors' `/api/**` to the proxy.

So every clone passes through `withCurrentGatewayRewrite` (`packages/admin-core/src/deploy/firebase-gateway-rewrite.ts`): the `/api/**` rewrite is replaced by the one the admin's `CAELO_GATEWAY_SERVICE` / `CAELO_GATEWAY_REGION` name, everything else is kept verbatim, and missing env vars fail loudly (no fallback). The redirect sync treats a stale rewrite as a change even when the redirects match, so a sync repoints the live site's `/api/**`. The converge itself does not re-release the live channel (a release outside a recorded run would make the plugin-data build refuse, "released outside Caelo"); instead the admin's first boot after it reads the live release and, when its rewrite is stale, runs one redirect sync of the production targets, which re-releases the served version and moves the recorded location with it (#1380, `repointStaleGatewayRewriteAtBoot`).

What the sync reports, also in the AI tools' results (`bulk_create_redirects`, `bulk_delete_redirects`): per target whether the redirects are live, and which redirects point at a page the live build does not have. A redirect to a page that is still a draft answers 404 at its target until that page is published.

Gates (CLAUDE.md §11.A) are unchanged. Creating or changing a redirect is routine: one `bulk_delete_redirects` call undoes it. An AI `redirects.delete_many` by `matches` that would delete 10 or more rows is refused (`AI_MATCHES_DELETE_LIMIT`). A move of 10 or more URLs is approval-gated (`move_pages`). `redirects.sync_provider` decides nothing (it pushes what was saved) and is human/system only.

## Global settings: classification

"Provider / runtime" settings are read where the site is served, so a save is the sync. "Rendered" settings are baked into the build. They are stored live (not on the chat's branch) and reach production only with the next Stage + Publish live: Publish live copies the staged build (#1330), and a staged build rendered for another origin than the live site's is refused with "Stage again". With #1154 nothing else builds production. Making them branch-aware draft state is #1158.

| Setting | Op(s) | Class | How it goes live | Approval (§11.A) |
|---|---|---|---|---|
| Redirects | `redirects.*` | provider | Sync on save (above) | AI `delete_many` by `matches` ≥10 rows refused; moves ≥10 URLs gated |
| Staging access gate: modes, credentials, staging host | `staging_access.set` / `rotate_credentials` / `set_host` | provider / runtime | The gateway reads the projected row (`cms_public`) per request, so the save is live. A new host also needs DNS + a domain mapping. | Gated (`propose_set_staging_access`, `propose_rotate_staging_credentials`, `propose_set_staging_host`) |
| Gateway: body cap, captcha provider, PoW prefix | `gateway.set_settings` | provider / runtime | Projected to the gateway on commit | Gated (`propose_set_gateway_settings`) |
| Gateway cookie secret | `gateway.rotate_cookie_secret` | provider / runtime | Projected on commit | Gated (`propose_rotate_gateway_cookie_secret`) |
| Rate-limit profiles and overrides | `gateway.set_rate_limit_profile` / `set_rate_limit_override` | provider / runtime | Projected on commit | Gated (`tune_rate_limit`) |
| Custom domains | `domains.add` / `remove` / `reconnect_hosting` | provider | gcp-firebase: the custom-domain API when the proposal is approved; self-hosted: the Caddy vhosts `cms-provision` writes from the table | Gated (`propose_add_domain`, `propose_remove_domain`, `propose_reconnect_domain`) |
| Response headers (security, cache, staging `X-Robots-Tag`) | none | provider | No operator setting. Code-defined, written by each publish. | n/a |
| Site base URL, sitemap toggle, Organization JSON-LD | `site_defaults.set_seo` | rendered (canonicals, og:url, sitemap, robots `Sitemap:` line, JSON-LD) | Next Stage + Publish live | Gated (`propose_set_site_seo`) |
| Site language (`<html lang>`) | `site_defaults.set_identity` | rendered | Next Stage + Publish live | Routine: one call undoes it |
| Media CDN copy | `site_defaults.set_media_cdn` | rendered (media URLs, `media-pass.ts`) | Next Stage + Publish live | Owner-only op |
| Robots policy and page URL style per target | `deploy_targets` row (Ops) | rendered (`robots.txt`, page file layout) | Next Stage + Publish live | Ops only |
| Home page, 404 page | `pages.set_home_page` / `pages.set_not_found_page` | rendered (page paths, `404.html`) | Next Stage + Publish live | Routine |
| Site name, purpose, design brief | `site_defaults.set_identity` | authoring only (AI context, never in the HTML) | Nothing to publish | Routine |
| Default layout / template / page type | `site_defaults.set` | authoring only (defaults for new pages) | Nothing to publish | Routine, justified at the op |
| Email, AI providers, budgets and pricing, MCP tokens, users and roles, skills, site memory, telemetry, bug forwarding, update policy | their own ops | admin only, never served to visitors | Nothing to publish | Per the §11.A table in CLAUDE.md |

Static files (`static_files.*`, #1461) are not settings either: they are stored in Caelo and reach a site only as files of a Stage build, so a save changes nothing until a Stage and Publish live ([static-files.md](./static-files.md)).

Themes, layouts, templates, content instances, lists and plugin rows are not global settings in this sense: they are already draft state that goes live with Stage + Publish live.
