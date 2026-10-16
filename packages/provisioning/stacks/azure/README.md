# Caelo Azure provider stack

Pulumi stack provisioning Caelo on Azure managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts`.

## What it provisions per environment

| Concern | Azure resource |
|---|---|
| Managed Postgres | Azure DB for PostgreSQL flexible server (zone-redundant in production) + automated backups (geo-redundant in production) |
| Blob storage | Storage Account with a private `media` container and static-website hosting (`$web`) |
| CDN / Edge | Azure Front Door Standard: the primary domain serves the static website as files, with a Front Door managed certificate; no edge compute on the request path |
| Container runtime | Four Container Apps (admin / gateway / orchestrator / runner) in one managed environment |
| Secret store | Key Vault (postgres-password, public-role-password, gateway-role-password, csrf-secret, cookie-secret, anthropic-api-key, resend-api-key). The gateway container gets `PUBLIC_DATABASE_URL` only, never a cms_admin credential of any role (#613, #635). |
| Edge-log sink | Log Analytics workspace receives Container Apps logs (queryable by P12A analytics plugin via Azure Monitor) |

The Caelo runtime never knows it's on Azure — every Container App consumes plain `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars.

## First-time install

Run this stack from a checkout of the Caelo repository after `bun install` at its root. `@pulumi/azure-native` is a devDependency of `@caelo-cms/provisioning`: the CLI wizard does not provision Azure yet, so the published package does not make every GCP and self-hosted install download it (the one-click install from Cloud Shell runs in a 5 GB home directory). It moves back to `dependencies` when the Azure wizard ships.

```bash
cd packages/provisioning/stacks/azure
pulumi stack init prod
pulumi config set caelo-azure:domain example.com
pulumi config set caelo-azure:ownerEmail me@example.com
pulumi config set caelo-azure:subscription <your-subscription-guid>
pulumi config set caelo-azure:region westeurope

# Build + push images. Operator does this on every release.
az login
az acr login --name <your-acr>
docker build -t <your-acr>.azurecr.io/admin:latest apps/admin
docker push <your-acr>.azurecr.io/admin:latest
# Repeat for gateway, orchestrator, runner.

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

`dnsRecordsRequiredOut` lists the two records the primary domain needs: a CNAME to the Front Door endpoint (`frontDoorEndpointHostNameOut`) and the `_dnsauth.<domain>` TXT record that validates the domain for Front Door's managed certificate. An apex domain needs a registrar that supports CNAME flattening / ALIAS records, or Azure DNS.

## v1 limitations (P15.4 review-pass items)

- **Container image build pipeline** — operators push via `az acr build` for v1.
- **Per-locale custom-domain SSL** — operator wires per-locale subdomains via additional Front Door custom-domain bindings.

## Destroy

```bash
pulumi destroy
```

Tears down all resources; the resource group is removed (which transitively removes everything inside it). Soft-deleted Key Vault entries linger per Azure's `softDeleteRetentionInDays` setting (90d in production; 7d elsewhere).
