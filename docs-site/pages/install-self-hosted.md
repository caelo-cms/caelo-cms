---
slug: install-self-hosted
template: doc-page
status: published
seo:
  title: Install — self-hosted — Caelo CMS
  description: Run Caelo on your own VM via Docker Compose with the signed, prebuilt release images — install, verified upgrades with backup and automatic rollback.
---

# Install — self-hosted

The simplest deployment target: one Linux host with Docker. One command writes a Docker Compose stack — Postgres, Caddy with automatic TLS, the admin and the API gateway — into `./.caelo/`, starts it, applies the database migrations and checks that everything answers.

The admin and the gateway run the **prebuilt release images** from `ghcr.io/caelo-cms/admin` and `ghcr.io/caelo-cms/gateway`, pinned by digest and verified with [cosign](https://docs.sigstore.dev/) against Caelo's release workflow before anything is written. You never build an image, and nothing of the Caelo source code is mounted into a container.

## Requirements

- A Linux box with public IPv4, ports 80 + 443 reachable, and DNS for three hosts pointed at it (for production TLS via Let's Encrypt): `<domain>` (the site), `admin.<domain>` (the admin) and `staging.<domain>` (the staging site, or the host you pass as `--staging-domain`)
- [Docker Engine](https://docs.docker.com/engine/install/) ≥ 20 with the Compose plugin
- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) — verifies the image signatures
- 2 GB RAM minimum (4 GB comfortable); 10 GB disk for Postgres + uploads
- For **Install update** in the admin: systemd (any mainstream Linux distribution), and a non-root user in the `docker` group to run the install as — see [Installing updates from the admin](#installing-updates-from-the-admin)

## Install

Run from the directory that should hold the install (the provisioner creates `./.caelo/` there):

```bash
bunx @caelo-cms/provisioning@latest --provider self-hosted \
  --domain caelo.example.com \
  --owner-email you@example.com
```

(`… init --provider self-hosted …` is the same command.) What happens:

1. The admin + gateway images of the provisioner's own Caelo version are resolved to digests in GHCR and **cosign-verified**. A failed check stops here; nothing is written. (`--version x.y.z` installs a different release.)
2. Secrets are generated and stored in `.caelo/config.json` (mode 600). The verified digests are recorded in `.caelo/release.json`.
3. `.caelo/docker-compose.yml`, `.caelo/Caddyfile` and `.caelo/bootstrap.sh` (creates the database roles on Postgres's first start; it holds no secrets) are written. The Compose file references the images by digest, so a `docker compose pull` can never change the release behind your back.
4. On Linux with systemd, the **update agent** is set up (see [below](#installing-updates-from-the-admin)), so the admin can install future releases. Elsewhere `init` says why it skipped it; updates then install with the `upgrade` command.
5. The stack starts: the images are pulled, Postgres starts (its first start creates the database roles and databases), the migrations run with the release's admin image, then Caddy, the admin and the gateway start, and the admin's and the gateway's health checks must pass.

Finally open the Owner-bootstrap URL the provisioner printed (`https://admin.<domain>/setup?token=…`). The token expires after 24 hours. Caddy serves the admin on `admin.<domain>`, the live site on `<domain>` (with `/api/*` going to the gateway) and the staging site on its own host, marked `noindex`.

If a step fails, the provisioner says which one and why. Fix the cause and run `bunx @caelo-cms/provisioning@<version> up` from the same directory: it re-checks the database roles, re-writes the Compose file and the Caddyfile, and converges the running stack from wherever it stopped. `up` is also what you run after changing anything in `.caelo/config.json`.

**Without public DNS** (a LAN box, an evaluation install): add `--tls internal`. Caddy then issues every certificate from its own local CA instead of Let's Encrypt; browsers warn until you trust that CA's root (`docker compose -f .caelo/docker-compose.yml exec caddy cat /data/caddy/pki/authorities/local/root.crt`). **Ports 80 / 443 taken** (another web server on the host): `--http-port` / `--https-port` publish Caddy elsewhere — Let's Encrypt can then only issue certificates if the other server forwards those hosts to Caddy, so combine them with `--tls internal` or a forwarding proxy.

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

## Installing updates from the admin

Settings → Updates in the admin can install a new Caelo release with one click (Owner only, confirmed with a fresh Google sign-in). On a self-hosted install the click does not install anything itself: it writes an update request into the database, and the **update agent** on your server carries it out.

The agent is a systemd timer (`caelo-agent-<your-domain>-<hash>.timer`; `agent status` names it) that runs the provisioning CLI **as your user** — the one that ran `init` — once a minute:

1. it checks in with the database (the admin shows "Install update" only while the agent has checked in within the last five minutes, and shows what it found wrong on the server, such as a missing `cosign`);
2. it picks up the oldest pending request;
3. it downloads the release's **signed release manifest** and verifies it with cosign against Caelo's release workflow. It refuses a bad signature, an older or equal version, a release that needs an intermediate one first, and — for automatic installs — releases with destructive database changes or ones your update policy does not allow;
4. it installs the provisioning CLI **of the new release** from npm into `.caelo/agent/cli/` (install scripts off) and verifies it the way the Cloud Shell installer does: `npm audit signatures` (registry signatures + Sigstore provenance) and SLSA provenance naming `caelo-cms/caelo-cms` at the release's tag. If that fails, the update is refused and nothing changes — there is no fallback to an unverified copy;
5. only then it starts that CLI to run exactly the [upgrade](#upgrading) described above: verified images (which must match the manifest's digests), database backup, migrations, health-checked restart, rollback. That CLI writes every step into the timeline on Settings → Updates, and afterwards the agent runs the new release itself.

Why a timer on the host and not a container: running Compose from inside a container needs the Docker socket, which is root on the host for anything that gets into that container. The agent needs nothing your user does not already have to run `docker compose`. No unit runs as root, and the admin never gets more than "write a request row".

The agent reaches Postgres as its own login, `caelo_agent`, which may only read update requests, move them through their run states, write their timeline and its heartbeat — nothing else in the database. For it, Postgres is published on the host's **loopback interface only** (`127.0.0.1:15432`, or the next free port; `--port` picks another) — never on a public interface. Publishing it restarts Postgres **once**, the first time the agent is set up: a few seconds of downtime, announced before it happens. Later runs find the port published and leave Postgres alone, and the agent itself never restarts Postgres outside an update.

### Set up, check, remove

`init` and `upgrade` set the agent up (or bring it up to date) automatically on Linux. To do it yourself, run from the directory that holds `.caelo/`:

```bash
bunx @caelo-cms/provisioning@<version> agent install     # idempotent; the first run restarts Postgres once (a few seconds)
bunx @caelo-cms/provisioning@<version> agent status      # timer, pinned version, last run
bunx @caelo-cms/provisioning@<version> agent logs        # its journal (--follow, --lines N)
bunx @caelo-cms/provisioning@<version> agent uninstall   # timer off; the port goes with Postgres's next restart; init/upgrade leave it off
```

Requirements on the server:

- **Your user is in the `docker` group** (as it already must be to run the install). Membership in that group is equivalent to root on the host — that is Docker's design, not the agent's; the agent adds no further access. Rootless Docker works too: `DOCKER_HOST` is carried into the unit.
- **npm** (Node.js) on the `PATH` the agent sees — it verifies the provenance of each release's CLI before running it.
- **cosign** on the `PATH` the agent sees (the `PATH` of the shell that ran `agent install` is written into the unit).
- **Lingering** for your user, so the timer runs while you are logged out. `agent install` switches it on (`loginctl enable-linger`); where the system policy does not allow that, it prints the one command an administrator runs: `sudo loginctl enable-linger <user>`.

**The Google sign-in.** Installing an update (and changing the update policy) needs a fresh Google sign-in, also on a self-hosted install. Settings → Updates walks you through creating a Google OAuth client once (in any Google Cloud project — it costs nothing) and pasting its ID and secret. Until that is done, the page shows the `upgrade` command to run instead.

## Day-2 operations

| Task | Command / location |
|---|---|
| Restart the stack | `docker compose -f .caelo/docker-compose.yml restart` |
| Tail logs | `docker compose -f .caelo/docker-compose.yml logs -f caelo-admin caelo-gateway caddy` |
| Apply DB migrations by hand | `bunx @caelo-cms/provisioning@<version> migrate` |
| Which release runs | `.caelo/release.json` (version, image digests, upgrade history) |
| Update agent | `bunx @caelo-cms/provisioning@<version> agent status` / `agent logs` |
| Back up the install | `bunx @caelo-cms/provisioning@<version> backup [--to file.tar.gz]` — see [Backup and restore](#backup-and-restore) |
| Restore a pre-upgrade backup | see *Troubleshooting* below |
| Rotate any secret | `/settings/<area>` in the admin OR see incident-response §G |
| Admin memory for the [quality checks](/quality-gate) | `caelo-self-hosted:adminMemory` (default `2Gi`, reserved for the admin container) |

## Backup and restore

Run from the directory that holds `.caelo/`:

```bash
bunx @caelo-cms/provisioning@<version> backup --to caelo-backup.tar.gz
bunx @caelo-cms/provisioning@<version> restore --from caelo-backup.tar.gz --yes
```

`backup` writes one archive (mode 600) with a `pg_dump` of both databases, the published site (`.caelo/output/`) and the uploaded media (`.caelo/media/`). The install keeps serving while it runs. It does **not** contain `.caelo/config.json` — the database passwords and the key that encrypts stored AI provider keys — so the archive can be copied off the host; keep a copy of `config.json` somewhere safe yourself, because without it encrypted provider keys in a backup cannot be read.

`restore` checks the archive first (nothing changes if it is incomplete), stops the admin and the gateway, replaces both databases and the files, and starts everything again with health checks. The database roles and their passwords come from this install's `config.json`, not from the archive. If a restore stops half-way, run it again: it starts over from the archive.

Backups are point-in-time snapshots, not continuous WAL archiving — run `backup` on a schedule (e.g. a daily cron job) and copy the archives off the host.

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

**An install made with an earlier release never came up (Caddy refuses the Caddyfile, `502` on the admin, `pgbackrest.conf` or `minio/minio` errors)** — earlier releases wrote a Caddyfile Caddy 2.11 refuses, proxied to `localhost` inside the Caddy container, put the admin on the same host as the site, and referenced a pgBackRest sidecar and a MinIO image that no longer exists. Run `bunx @caelo-cms/provisioning@latest up` once from the directory that holds `.caelo/`: it rewrites both files, removes the old services and starts the stack. The admin is then at `admin.<domain>` — add that DNS record.

**`release.json records no release images`** from `up` — the install predates prebuilt images. Run `upgrade` once to move it onto them.

**Settings → Updates says the update agent is not set up, or not running** — run `agent status` on the server. `not installed`: run `agent install`. Installed but no recent run: `agent logs` shows why; the usual causes are the install being stopped (`docker compose … up -d`), lingering being off (the timer stops when you log out — see above), or the login `caelo_agent` missing after a restore (re-run `agent install`, which re-creates it).

**`Docker is not reachable for the agent's user`** on the update timeline — the user the agent runs as cannot reach the Docker daemon. Add it to the `docker` group (`sudo usermod -aG docker <user>`, then log in again) and re-run `agent install`.

**`cosign is not installed on the server`** — install cosign so it is on the `PATH` of your shell, then re-run `agent install` (it records that `PATH` in the unit).

**`another upgrade is running on this install`** — the agent and a hand-run `upgrade` never roll at the same time (`.caelo/upgrade.lock`). Wait for the other one to finish; a lock left by a crashed run is taken over automatically.

**An update ended "needs the upgrade command on the server"** — the install has no recorded release yet (it predates prebuilt images), or the release information is newer than the agent understands. Run the `upgrade` command shown on Settings → Updates once on the server; afterwards the admin can install updates again.

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
