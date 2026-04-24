# Phase 14 — Pulumi self-hosted provisioning

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P6 (MVP), P13 (hardened stack).
**Unblocks:** P15 (cloud adapters share the Pulumi umbrella).

## Goal (from master plan)
Pulumi TypeScript project in `packages/provisioning`. `bunx cms-provision --provider self-hosted` stands up Docker Compose with PostgreSQL + pgBackRest WAL streaming + Caddy (static hosting + Let's Encrypt SSL) + MinIO (object storage) + the CMS services. Single command, no cloud account. **The provisioned stack materialises the dev/staging/production three-environment model from requirements §16.5** — separate database schemas (or a second DB instance for production), separate Caddy virtual hosts for staging and production, staging forced to `noindex`. Deliverable: a fresh Linux box reaches a production-quality self-hosted install in one command, with both staging and production endpoints reachable over SSL.

## End-to-end verification
Fresh VM → `bunx cms-provision --provider self-hosted` → **both `staging.<domain>` and `<domain>` reachable over SSL; staging returns `X-Robots-Tag: noindex`, production does not; AI admin changes appear on staging until explicitly promoted to production.**

## To be detailed before execution
- Pulumi version (verify current) + `@pulumi/command` for Docker Compose orchestration.
- Provisioning inputs: domain, admin email (Let's Encrypt), DB password, initial owner credentials, **staging subdomain (defaults to `staging.<domain>`)**.
- Stack layout: `postgres` + `pgbackrest` + `caddy` + `minio` + `admin` + `api-gateway` + `static-host-staging` + `static-host-production`.
- **Environment isolation:** production and staging share PostgreSQL but sit in separate schemas with per-env grants; Caddy hostnames routed independently; promote = atomic copy of `dist-staging/` → `dist-production/` (no rebuild).
- pgBackRest: WAL streaming to MinIO bucket; documented restore procedure.
- Caddy: automatic Let's Encrypt; reverse proxy to admin and API gateway; serves per-env `dist/` volumes. Staging vhost adds `header X-Robots-Tag "noindex"` and serves its own `robots.txt`.
- Patroni opt-in path: documented but not default, per requirements §13.2.
- Bootstrap: first-run owner setup wizard on first visit post-provision.
- **Site Import Wizard** (also re-runnable from admin later, not provisioning-only):
  - User supplies an existing site URL.
  - Sandboxed scrape tool fetches pages + assets; respects robots.txt + rate limits.
  - `import-site` skill (P10A) drafts modules, template blocks, typed content entries, and media — all staged into a site snapshot; nothing published automatically.
  - **Screenshot-based design verification:** headless browser renders each imported page in Caelo; captures a reference screenshot of the source URL; runs a visual diff; each page gets a pass / warn / fail badge. Publish is blocked on fail until the user acknowledges or fixes.
  - All import output routes through the standard P4 snapshot + preview + confirm flow, so nothing about the import bypasses existing safety rails.
