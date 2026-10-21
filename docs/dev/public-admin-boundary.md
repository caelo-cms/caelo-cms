# The public/admin boundary

Caelo runs two sides that must stay apart (CLAUDE.md §2):

- **The admin side** holds the authoring database `cms_admin`. It runs as `admin_role` in the admin app and its in-process workers.
- **The public side** is the API gateway (`apps/api-gateway`), the only compute a visitor reaches. It uses `cms_public` as `public_role` and nothing else.

The rule: **assume the public side is fully compromised.** That covers the gateway process, its credentials and the whole `cms_public` database. Even then, the attacker must not be able to change anything on the authoring side.

Two consequences follow:

1. **The public side has no path to `cms_admin`** (issue #635). The gateway has no `cms_admin` login. It does not connect to it, and its environment holds no credential for it.
2. **Data from public to admin is untrusted.** Every row the admin reads from `cms_public` may have been written by an attacker. The admin validates it, renders it as text, and never lets it drive a privileged action on its own.

## How the gateway gets what it needs: the published projection

The gateway still needs some authoring state:

- its settings (cookie secret, body cap, captcha);
- the staging gate;
- rate-limit overrides;
- the active plugins;
- the visitor-readable parts of plugin private storage;
- approved comments.

The admin **publishes** exactly that into `cms_public`. Data flows one way, admin to public:

| Section | Source (`cms_admin`) | Published to (`cms_public`) |
|---|---|---|
| `settings` | `site_settings` (4 gateway columns) | `published_gateway_settings` |
| `staging` | `staging_access` | `published_staging_access` |
| `rate_limits` | `plugin_rate_limit_overrides`, `rate_limit_profiles` | `published_rate_limits` (profile already resolved) |
| `plugins` | `plugins`, `actors`, `plugin_capability_grants`, `plugin_installation_versions` | `published_plugins`, `published_plugin_grants` |
| `plugin:<id>` | the plugin's `visitorProjection` tables (main line only) | `published_plugin_rows` (readable only under that plugin's id) |
| `comments` | `comment_archive`, approved rows | `published_comments` |

Where each piece lives:

- **What crosses** is declared in `packages/migrations/src/public-projection.ts`, column by column. For plugins, it is the plugin's `visitorProjection` (plugin SDK). Widening the projection is a reviewed change to one of those two places.
- **Freshness.** Triggers in `cms_admin` migration 0281 record every committed write to a source table in `public_projection_outbox`, in the same transaction as the write, and flag that transaction (`caelo.projection_dirty`).
  - **Before the admin call returns.** When a transaction of the admin's `DatabaseAdapter` (an op, or a worker's `withAdminTransaction`) commits with that flag, the adapter publishes the stale sections and waits for it before returning. A revoked grant, a deactivated plugin, an unapproved comment, a rotated cookie secret or a closed staging gate is live on the public side when the admin call returns. If that publish fails, the op reports "saved, but not live yet" instead of success.
  - **Backstop.** The admin also drains the outbox every 2 seconds (admin-core `startPublicProjectionPublisher`), for writes from anywhere else and for publishes that failed. Two more paths publish everything: the migration job, after migrating `cms_public`, so a freshly rolled gateway finds its data; and the admin, when it boots.
  - **Exactly what was read.** A drain deletes the outbox rows it read, by id, never a range: ids are taken at insert but become visible at commit, so a lower id can commit while a drain runs. Such a row stays for the next drain.
- **Notification.** After each publish the admin sends `NOTIFY caelo_gateway_settings` on `cms_public`, and the gateway drops its caches.
- **Not published yet is loud.** A section that was never published makes the gateway answer `503` with `ProjectionNotPublished`. That holds for the plugin registry too: while it is unpublished, a request for any plugin is a 503, not a 404 `PluginNotFound`. The gateway never serves an empty answer, so "nothing is active" and "nobody told us" cannot look the same.

On the gateway side, `ctx.adminQuery` is a **read-only** handle over the plugin's published projection (plugin-host `published-state.ts`). A table or column outside the declaration is unreachable, and every write throws.

## What the gateway owns: its own state in `cms_public`

The gateway writes these tables (all in `cms_public`, migration 0280):

- `gateway_request_log`
- `gateway_rate_limit_buckets`
- `gateway_pow_challenges`
- `gateway_plugin_op_events`

The gateway garbage-collects them itself. Every column is bounded by a `CHECK`. `public_role` can insert log and event rows but cannot read them back, and it may insert only their payload columns: `id` comes from the sequence and `created_at` from `now()`.

The redeploy orchestrator keeps a watermark on `gateway_plugin_op_events.id`. It never moves past the sequence's last value, so no row can push it beyond events still to come. It moves only through a contiguous run of ids, because ids commit out of order; a gap closes once the row after it is 30 seconds old.

Plugin op records from visitor calls go to `gateway_plugin_op_events`. They never go to `audit_events`: the public side must not be able to forge entries in the admin's audit trail.

`public_role` may insert an op event only for a plugin listed in `published_plugins` (the active plugins the admin published), and only when the slug before the `.` in `operation` is that plugin's slug (cms_public migration 0300). The orchestrator still validates every row it reads: a stale projection can list a plugin that `cms_admin` has since disabled or removed.

### Rate-limit buckets and the visitor's address

A recognised visitor (a consented, signed `caelo_visitor_id` cookie it already held) is bucketed by its id; everything else is bucketed by its client address. That address is the `X-Forwarded-For` entry `CAELO_TRUSTED_PROXY_HOPS` places from the end (`apps/api-gateway/src/client-ip.ts`): proxies append, so earlier entries are the client's own and forgeable, and the last entry is the closest proxy, not the visitor, when there is more than one hop. The value is a property of each adapter's topology, declared once in `packages/provisioning/src/stack-contract.ts` (`GATEWAY_TRUSTED_PROXY_HOPS`): gcp 2 (external LB), gcp-firebase 1, self-hosted 1 (Caddy), azure 1, aws 2. On gcp-firebase the trusted entry for `/api/**` is the Firebase Hosting CDN edge, because the gateway is also reachable directly on `*.run.app` and any entry before Cloud Run's own is forgeable. IP-scoped buckets there are coarse (per edge address), but a client cannot rotate them. The gateway refuses to boot without the variable, and answers 503 `ClientAddressUnavailable` to a request carrying fewer entries than the topology always appends. Changing an adapter's path to the gateway means updating its entry.

## The one HTTP path to the admin: remote MCP (issue #806)

Remote MCP clients (claude.ai, ChatGPT, Claude Code over HTTP, Cursor, VS Code) reach the admin's MCP surfaces through the gateway (`apps/api-gateway/src/mcp/`). This is the only request the gateway ever sends to the admin, and it gives a compromised gateway nothing:

- **No admin credential, no allowlisted identity.** The gateway is an OAuth broker for the user's own Google sign-in. The bearer it forwards to `/api/mcp/remote/<surface>` is the user's Google ID token (audience: the install's Google sign-in client, which the project's IAP settings list in `oauthSettings.programmaticClients`, #914), the token IAP's programmatic access documents. The client never holds that token bare: its bearer is the ID token sealed with the surface it was approved for (`mcp/access-token.ts`), and the gateway refuses it on the other surface. IAP still checks every request; the admin then reads the user from IAP's signed `x-goog-iap-jwt-assertion`. A gateway without a valid token of an allowlisted user is refused by IAP like anyone else.
- **Headers by allowlist, both ways.** Only `authorization`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id` and `user-agent` cross to the admin; `x-forwarded-host`/`-proto` are set fresh. An inbound `x-goog-iap-jwt-assertion`, `x-caelo-*` or `cookie` never reaches the admin. Back to the client go only `content-type`, `cache-control`, `mcp-session-id` and `mcp-protocol-version`, plus the gateway's own CORS headers; any 401 becomes the gateway's own `WWW-Authenticate` challenge.
- **No database, no admin code.** The broker is stateless: what it must remember (the consent token, the Google `state`, the authorization code, the refresh token, a registered client) is sealed with AES-256-GCM under `CAELO_MCP_OAUTH_SEAL_KEY` (plus `CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS` during a key rotation), purpose-bound per kind. Its configuration is env plus the OAuth client file (a Secret Manager volume the admin writes, `{}` until an Owner sets it up). The routes run before the gateway's settings load; they are rate limited per client address in process (`mcp/rate-limit.ts`), by the same address rule as above.
- **Codes go only to known clients, and only after the user approves.** Registration (DCR, CIMD) is open, so the redirect-URI allowlist (`mcp/redirect-allowlist.ts`) decides where an authorization code may go: the listed vendor callbacks and RFC 8252 loopback. Because some allowlisted callbacks belong to platforms where anyone can own a callback id, `/authorize` first shows a consent page on the gateway's own origin (`mcp/consent.ts`: where the user is sent back to, the app's self-chosen name marked unverified, the surface). Approve is bound to a `__Host-` cookie in the user's browser, and Google's callback is refused in a browser that did not approve. CIMD documents are fetched only from `claude.ai` and `chatgpt.com`.
- **Grants are bounded.** The broker checks the PKCE verifier itself before calling Google, binds each grant to the resource it was authorized for (RFC 8707), and stops refreshing 30 days after the sign-in.

## Reading public data on the admin side

Everything the admin reads from `cms_public` crosses a trust boundary. The rules:

1. **Validate at the boundary.** Each row must match a strict, bounded Zod schema when it is read. A row that does not fit is dropped and counted, never coerced (`parseUntrustedRows`, admin-core `untrusted/public-data.ts`).
2. **Render as text.** Svelte interpolation only. Never `{@html}`, never a markdown renderer that turns links or images into live elements.
3. **Never drive a privileged action without a human or validator step.** A public row can be a *hint*. Example: a plugin op event can schedule a rebuild, but only for a page that exists in `cms_admin`, and the rebuild reads the authoritative state. A public row is never an instruction.
4. **Never instructions to the AI.** Every plugin tool result reaches the admin AI wrapped in `<untrusted-plugin-data>` (`untrustedToolResult` in `@caelo-cms/shared`), and the static system prompt says what that means. Prompts built from visitor text fence it the same way. The admin AI holds publish and deploy tools (#763 M8).

Every read path and how it meets these rules: [public-admin-read-paths.md](./public-admin-read-paths.md).
5. **No reverse sync.** The admin never copies public state into a table it trusts, unless a validator or a human decides first. Example: comment moderation archives a comment only through the Zod-validated `comment_archive.insert`, on an Owner or AI decision.

## Guardrails that keep it so

Each one fails loudly. Do not widen any of them to make a change pass: the change is what breaks the boundary.

| Guardrail | Where | Fails when |
|---|---|---|
| **Boot refusal (env)** | `apps/api-gateway/src/database-env.ts` (`adminDatabaseAccessInEnv`) | The gateway's environment offers database access besides its own login. Only `PUBLIC_DATABASE_URL` (public_role on cms_public) and `PUBLIC_DATABASE_PASSWORD` may be database-related. Refused: any other variable whose name has a database, `PG*`, DSN or password token (`DATABASE_URL`, `PGPASSWORD`, `DB_ADMIN_PASS`, …); any value holding a Postgres URL or a libpq keyword string (`host=… dbname=… user=…`) or naming `cms_admin`, `admin_role` or `gateway_role`; the same for the file a `*_FILE` variable names and for every file in `/run/secrets` and `/var/run/secrets`. Not detectable: a bare password under a name with no such token, or a secret file at a path nothing names; the database check below and the adapter tests cover those. The error names variables and files, never values. |
| **Boot refusal (database)** | `databaseIsolationProblems`, run by `server.ts` at boot | The gateway's login can `CONNECT` to cms_admin, or cms_public carries `dblink`, `postgres_fdw` or a foreign server. |
| **No admin pool** | `DatabaseAdapter({ adminDatabaseUrl: null })` | Code in the gateway reaches for cms_admin: `AdminDatabaseUnavailableError`. |
| **Role audit** | `packages/migrations/src/role-audit.ts`, run after every migration (install, `upgrade`, in-cloud upgrader, self-hosted) | `public_role` or `PUBLIC` holds any privilege on a cms_admin object (table, column, schema, sequence, function, default privileges), or `public_role` may connect to cms_admin or belongs to a privileged group. Also fails when cms_public holds a bridge to another database. The migration job exits non-zero and nothing rolls. |
| **Import graph** | `apps/api-gateway/src/gateway-boundary.test.ts` | The gateway entry point or any shipped plugin reaches an admin-only package (`admin-core`, `migrations`, `provisioning`, …), or the gateway's operation registry holds an operation on cms_admin. |
| **Migration lint** | `packages/migrations/src/grant-lint.test.ts` | A cms_admin migration grants anything to `public_role` or `PUBLIC`, or (after 0281) to `gateway_role`. A grantee computed at run time (`' TO ' \|\| role`, `format('… TO %I', …)`) fails unless the line carries a `-- caelo:dynamic-grantee <reason>` annotation. Also fails when any migration installs a cross-database bridge. |
| **Runtime grant check** | `packages/plugin-sandbox/src/schema.ts` (`grantStatement`) | The plugin schema DDL the admin runs at boot grants to a role outside the allowed set for its database: admin_role in cms_admin, public_role and admin_role in cms_public. The former `gateway_role` gets nothing; the provisioning DDL only revokes what it held. |
| **Adapter env** | `packages/provisioning/src/gateway-env-isolation.test.ts` | The gateway service on any adapter (gcp, gcp-firebase, self-hosted Compose, azure, aws) gets a cms_admin URL, role or credential, or its identity can read a secret that unlocks one: GCP secret bindings of the gateway SA, the AWS gateway task role's policy, Azure Key Vault access, the Compose service's secrets and mounts. |
