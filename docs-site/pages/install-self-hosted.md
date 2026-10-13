---
slug: install-self-hosted
template: doc-page
status: published
seo:
  title: Install — self-hosted — Caelo CMS
  description: Run Caelo on your own VM via Docker Compose. One command provisions Postgres, pgBackRest, Caddy with TLS, the admin, and the gateway.
---

# Install — self-hosted

The simplest deployment target. One Linux host, Docker, Bun. The provisioner emits a Docker Compose stack that wraps everything.

## Requirements

- A Linux box with public IPv4 + DNS pointed at it (for production TLS via Let's Encrypt)
- [Docker Engine](https://docs.docker.com/engine/install/) ≥ 20
- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- 2 GB RAM minimum (4 GB comfortable); 10 GB disk for Postgres + uploads

For local development without a public domain, Caddy uses an internal CA + self-signed certs and the install reaches `https://localhost`. Browsers warn; that's expected.

## Run the provisioner

```bash
bunx @caelo-cms/provisioning@latest --provider self-hosted \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

What happens:

1. **Pulumi state** is created locally in `~/.caelo/state/<install-id>/`. No remote backend is configured by default.
2. **Docker Compose stack** is rendered into `~/.caelo/<install-id>/docker-compose.yml` + `caddy.json`.
3. **Postgres + pgBackRest** start; the two databases (`cms_admin`, `cms_public`) initialise with two roles + RLS forced.
4. **Caddy** brings up with auto-TLS for your domain. (For local installs, internal CA.)
5. **Admin app + API gateway** boot. The admin migrates the schema + seeds the system actor.
6. The provisioner prints an Owner-bootstrap URL — **open it within 15 minutes**; the bootstrap token expires.

## What you get

- `https://caelo.example.com` — the admin
- `https://caelo.example.com/edit` — the live-edit surface
- `https://caelo.example.com/api/plugin/...` — public visitor write endpoints (rate-limited, captcha-gated)
- TLS auto-renewed by Caddy
- Daily Postgres base backup + WAL streaming via pgBackRest into `~/.caelo/<install-id>/backups/`

## Day-2 operations

| Task | Command / location |
|---|---|
| Restart the stack | `cd ~/.caelo/<install-id> && docker compose restart` |
| Tail logs | `docker compose logs -f admin gateway caddy` |
| Take a manual base backup | `docker compose exec postgres pgbackrest --stanza=main backup` |
| Restore from backup | See [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md) §F |
| Rotate any secret | `/settings/<area>` in the admin OR see incident-response §G |
| Admin memory for the [quality checks](/quality-gate) | `caelo-self-hosted:adminMemory` (default `2Gi`, reserved for the admin container) |

## Upgrading

There is no upgrade command for self-hosted installs yet: the provisioning CLI's `upgrade` covers Google Cloud installs so far, and the self-hosted path (prebuilt, signed images and an updater on the host) is being built in [#696](https://github.com/caelo-cms/caelo-cms/issues/696). The admin's **Settings → Caelo updates** page shows the version you run and when a new release is out, with its release notes.

## Single-host limits + when to move to cloud

A single self-hosted install handles roughly:

- ~50k visitor pageviews/day (Caddy + static cache)
- ~500 concurrent visitor writes via the gateway
- ~10k editorial actions/day in the admin

Past those numbers, the bottleneck is usually Postgres + the lack of read-replica failover. The cloud adapters ([GCP](/install-gcp) / [AWS](/install-aws) / [Azure](/install-azure)) give you Cloud SQL HA / RDS Multi-AZ / Azure DB zone-redundant out of the box.

## Next

- [GCP install →](/install-gcp)
- [Architecture →](/architecture)
- [Operating + incident response runbook](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md)
