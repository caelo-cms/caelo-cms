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

## Reading public data on the admin side

Everything the admin reads from `cms_public` crosses a trust boundary. The rules:

1. **Validate at the boundary.** Each row must match a strict, bounded Zod schema when it is read. A row that does not fit is dropped and counted, never coerced (`parseUntrustedRows`, admin-core `untrusted/public-data.ts`).
2. **Render as text.** Svelte interpolation only. Never `{@html}`, never a markdown renderer that turns links or images into live elements.
3. **Never drive a privileged action without a human or validator step.** A public row can be a *hint*. Example: a plugin op event can schedule a rebuild, but only for a page that exists in `cms_admin`, and the rebuild reads the authoritative state. A public row is never an instruction.
4. **Never instructions to the AI.** Visitor content must reach the admin AI as data, never as instructions. The admin AI holds publish and deploy tools (#763 M8).
5. **No reverse sync.** The admin never copies public state into a table it trusts, unless a validator or a human decides first. Example: comment moderation archives a comment only through the Zod-validated `comment_archive.insert`, on an Owner or AI decision.
