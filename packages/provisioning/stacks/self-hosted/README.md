# Caelo self-hosted Pulumi stack

Real Pulumi resources around the self-hosted Docker Compose generators in `packages/provisioning/src/`. Two operator paths:

| Tool             | When to use                                                       |
|------------------|--------------------------------------------------------------------|
| `cms-provision`  | Dev iteration, initial install, ad-hoc backups + Caddy regen.     |
| Pulumi (this)    | Production install with state tracking + `pulumi destroy` semantics. |

Both share the same generators, so a stack imported from one tool can be re-managed by the other.

## First-time install

```bash
cd packages/provisioning/stacks/self-hosted
pulumi stack init prod
pulumi config set caelo-self-hosted:domain example.com
pulumi config set caelo-self-hosted:ownerEmail me@example.com
pulumi up
```

Pulumi mints postgres + minio passwords, generates `docker-compose.yml` + `Caddyfile` + `pending-token.json` under `.caelo/`, and runs `docker compose up -d`. After the run:

```bash
pulumi stack output bootstrapUrl
# → https://example.com/setup?token=<64-hex>
```

Open that URL once Caddy has issued the cert (~30 s).

## Destroy

```bash
pulumi destroy
```

Tears down the compose stack with `-v`, deleting all volumes (Postgres + MinIO + Caddy data). The generated files are removed too.

## Why this exists alongside `cms-provision`

The `cms-provision` CLI is the contributor-friendly path — runs without Pulumi installed, fast iteration on the generators themselves. The Pulumi stack is the **production wrapper**: it exposes a real resource graph for drift detection (operators can see what changed since last `up`), supports `--target` for surgical updates, and gives P15's GCP / AWS / Azure adapters a sibling `stacks/<provider>/` shape to slot into.

Cloud variants in P15 will follow the same pattern: each provider is a sibling Pulumi project under `stacks/`, sharing the compose + Caddyfile generators where applicable and adding provider-specific resources (Cloud SQL, RDS, etc.) on top.
