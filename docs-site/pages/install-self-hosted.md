---
slug: install-self-hosted
template: doc-page
status: published
seo:
  title: Install — self-hosted — Caelo CMS
  description: Run Caelo on your own VM via Docker Compose with the signed, prebuilt release images — install, verified upgrades with backup and automatic rollback.
---

# Install — self-hosted

The simplest deployment target: one Linux host with Docker. The provisioner writes a Docker Compose stack — Postgres, Caddy with automatic TLS, MinIO, the admin and the API gateway — into `./.caelo/` and gives you the commands to start it.

The admin and the gateway run the **prebuilt release images** from `ghcr.io/caelo-cms/admin` and `ghcr.io/caelo-cms/gateway`, pinned by digest and verified with [cosign](https://docs.sigstore.dev/) against Caelo's release workflow before anything is written. You never build an image, and nothing of the Caelo source code is mounted into a container.

## Requirements

- A Linux box with public IPv4 + DNS pointed at it (for production TLS via Let's Encrypt)
- [Docker Engine](https://docs.docker.com/engine/install/) ≥ 20 with the Compose plugin
- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) — verifies the image signatures
- 2 GB RAM minimum (4 GB comfortable); 10 GB disk for Postgres + uploads

## Install

Run from the directory that should hold the install (the provisioner creates `./.caelo/` there):

```bash
bunx @caelo-cms/provisioning@latest init --provider self-hosted \
  --domain caelo.example.com \
  --owner-email you@example.com
```

What happens:

1. The admin + gateway images of the provisioner's own Caelo version are resolved to digests in GHCR and **cosign-verified**. A failed check stops here; nothing is written. (`--version x.y.z` installs a different release.)
2. Secrets are generated and stored in `.caelo/config.json` (mode 600). The verified digests are recorded in `.caelo/release.json`.
3. `.caelo/docker-compose.yml` and `.caelo/Caddyfile` are written. The Compose file references the images by digest, so a `docker compose pull` can never change the release behind your back.

Then start it — the provisioner prints these commands with your paths filled in:

```bash
docker compose -f .caelo/docker-compose.yml up -d postgres
bunx @caelo-cms/provisioning@<version> migrate   # the provisioner prints this with its exact version
docker compose -f .caelo/docker-compose.yml up -d
```

Finally open the Owner-bootstrap URL the provisioner printed (`https://<domain>/setup?token=…`). The token expires after 24 hours.

## Upgrading

Copy the command from **Settings → Caelo updates** in the admin: it names the release, and runs the provisioner of that same release. By hand:

```bash
bunx @caelo-cms/provisioning@<version> upgrade --version <version>
```

Without `--version`, `upgrade` installs the newest stable release.

**Automatic updates** (Settings → Caelo updates) install releases on their own only where the admin has an upgrader to hand them to. Until this install has one, the policy there still decides what you are told: the admin emails the Owner when a release is out (through the email service at Settings → Email) and says on the page why it cannot install it by itself.

Run it from the directory that holds `.caelo/`. In order, it:

1. resolves the target release's admin + gateway digests and **cosign-verifies** them — a failed check changes nothing;
2. **backs up both databases** with `pg_dump` into `.caelo/backups/pre-upgrade-<timestamp>/` — if the backup fails, the upgrade does not start;
3. writes the new digests into the Compose file and pulls the images;
4. runs the database migrations **with the new admin image** while the current release keeps serving (Caelo migrations are expand-only, so the running release works on the new schema);
5. restarts the admin, waits for `/_caelo/health`, then restarts the gateway and waits for its health check;
6. records the new version in `.caelo/release.json`.

If a health check fails, the previous images are started again and checked, and `release.json` notes the rolled-back attempt. Re-running `upgrade` is safe: on an install that already runs the target release it only makes sure the containers match the Compose file and pass their health checks, and an interrupted run is simply repeated. The published site (`.caelo/output/`) and uploaded media (`.caelo/media/`) live on the host, so recreating the admin never loses them.

An install created before prebuilt images existed (its Compose file bind-mounts the Caelo repository into `oven/bun`) is moved onto the signed images by its first `upgrade`. Its uploaded media is copied (not moved) from the checkout's `apps/admin/data/media` into `.caelo/media/`, and its original Compose file is kept as `.caelo/docker-compose.pre-release.yml` for rollback.

## Day-2 operations

| Task | Command / location |
|---|---|
| Restart the stack | `docker compose -f .caelo/docker-compose.yml restart` |
| Tail logs | `docker compose -f .caelo/docker-compose.yml logs -f caelo-admin caelo-gateway caddy` |
| Apply DB migrations by hand | `bunx @caelo-cms/provisioning@<version> migrate` |
| Which release runs | `.caelo/release.json` (version, image digests, upgrade history) |
| Restore a pre-upgrade backup | see *Troubleshooting* below |
| Rotate any secret | `/settings/<area>` in the admin OR see incident-response §G |
| Admin memory for the [quality checks](/quality-gate) | `caelo-self-hosted:adminMemory` (default `2Gi`, reserved for the admin container) |

## Troubleshooting

**`cosign is required … was not found on PATH`** — install cosign (`brew install cosign`, or the Linux release binary from the sigstore docs) and re-run. `--skip-verify` exists for forks that publish unsigned images; never use it for a production install.

**`cosign verify FAILED`** — the image's signature does not come from Caelo's release workflow. Do not continue: either the registry or your network path is serving a different image, or you passed a fork's version. Retry once in case sigstore had an outage.

**`Could not resolve ghcr.io/caelo-cms/admin:<version>`** — the version does not exist (check the [releases](https://github.com/caelo-cms/caelo-cms/releases)) or GHCR is unreachable from the host.

**`Postgres is not running, so no backup can be taken`** — start it with `docker compose -f .caelo/docker-compose.yml up -d postgres` and re-run `upgrade`.

**Upgrade failed at `migrate`** — the previous release is still running and the Compose file is unchanged. The error shows the failing migration; fix the cause (often disk space or a manually changed table) and re-run.

**Upgrade rolled back after a failed health check** — the previous release is running again. See why the new one failed with `docker compose -f .caelo/docker-compose.yml logs caelo-admin` (or `caelo-gateway`). If the output says `ROLLBACK FAILED`, the previous images did not come back healthy either: check `docker compose ps`, and restore the pre-upgrade backup if the database is the cause:

```bash
B=.caelo/backups/pre-upgrade-<timestamp>
docker compose -f .caelo/docker-compose.yml exec -T postgres pg_restore -U caelo --clean -d cms_admin < $B/cms_admin.dump
docker compose -f .caelo/docker-compose.yml exec -T postgres pg_restore -U caelo --clean -d cms_public < $B/cms_public.dump
```

**`release.json records no release images`** from `up` — the install predates prebuilt images. Run `upgrade` once to move it onto them.

## Contributor dev mode

Contributors working on Caelo itself can run the admin + gateway from their checkout instead of the release images: `bun packages/provisioning/src/cli.ts init --dev …` from the repository root. The Compose file then bind-mounts the checkout into `oven/bun` and is labelled `DEV MODE`. It is never the default, only works from a checkout, and `upgrade` refuses it (update the checkout instead).

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
