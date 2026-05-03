# Caelo Azure provider stack

Pulumi stack provisioning Caelo on Azure managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts`.

## What it provisions per environment

| Concern | Azure resource |
|---|---|
| Managed Postgres | Azure DB for PostgreSQL flexible server (zone-redundant in production) + automated backups (geo-redundant in production) |
| Blob storage | Storage Account + two containers (`media` private, `$web` static-website-enabled) |
| CDN / Edge | Azure Container Apps `edge-router` instance (Front Door + custom-domain bindings land in P15.4 review-pass) |
| Edge compute (A/B + redirects) | Container App `edge-router` running `edge-handler.ts` with `@caelo-cms/edge-router` |
| Container runtime | Five Container Apps (admin / gateway / orchestrator / runner / edge-router) in one managed environment |
| Secret store | Key Vault (postgres-password, csrf-secret, cookie-secret, anthropic-api-key, resend-api-key) |
| Edge-log sink | Log Analytics workspace receives Container Apps logs (queryable by P12A analytics plugin via Azure Monitor) |

The Caelo runtime never knows it's on Azure — every Container App consumes plain `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars.

## First-time install

```bash
cd packages/provisioning/stacks/azure
pulumi stack init prod
pulumi config set caelo-azure:domain example.com
pulumi config set caelo-azure:ownerEmail me@example.com
pulumi config set caelo-azure:subscription <your-subscription-guid>
pulumi config set caelo-azure:location westeurope

# Build + push images. Operator does this on every release.
az login
az acr login --name <your-acr>
docker build -t <your-acr>.azurecr.io/admin:latest apps/admin
docker push <your-acr>.azurecr.io/admin:latest
# Repeat for gateway, orchestrator, runner, edge-router.

# Bring the stack up.
pulumi up

# Sync outputs into cms_admin.provisioning_outputs via the
# /api/internal/provisioning-outputs/sync endpoint (P15.1 signed-JWT).
CAELO_INTERNAL_SECRET=$(pulumi stack output --show-secrets internalSecretOut) \
CAELO_ADMIN_URL=https://example.com \
  bunx cms-provision pulumi-output-sync --environment production
```

The bootstrap-token URL is a Pulumi output:

```bash
pulumi stack output bootstrapUrlOut
# → https://example.com/setup?token=<64-hex>
```

## v1 limitations (P15.4 review-pass items)

- **Front Door + custom-domain SSL** not auto-provisioned. v1 surfaces the edge-router Container App's FQDN as the temporary CNAME target; P15.4 wires Front Door + ManagedIdentity-based cert binding.
- **Container image build pipeline** — operators push via `az acr build` for v1.
- **Per-locale custom-domain SSL** — operator wires per-locale subdomains via Front Door custom-domain bindings; auto-provisioning lands alongside the Front Door wiring.

## Edge-router byte-identity

The byte-identity test in `packages/edge-router/src/index.test.ts` asserts a fixed corpus of (visitorId, manifestVersion, experimentId) tuples produces identical variant labels across every runtime — a visitor sees the same variant whether they hit self-hosted Caddy in dev, AWS CloudFront in staging, or Azure Container Apps in production.

## Destroy

```bash
pulumi destroy
```

Tears down all resources; the resource group is removed (which transitively removes everything inside it). Soft-deleted Key Vault entries linger per Azure's `softDeleteRetentionInDays` setting (90d in production; 7d elsewhere).
