---
slug: install-azure
template: doc-page
locale: en
status: published
seo:
  title: Install on Azure — Caelo CMS
  description: Deploy Caelo to Azure via Pulumi. Azure DB for PostgreSQL + Blob Storage + Front Door + Container Apps + Key Vault.
---

# Install — Microsoft Azure

The `--provider azure` adapter mirrors the GCP / AWS shape on Azure-equivalent services.

| Layer | Azure service |
|---|---|
| Database | **Azure DB for PostgreSQL** (zone-redundant) |
| Object storage | **Blob Storage** (one public-access container + one private) |
| Edge | **Azure Front Door** with managed cert |
| Compute (admin + gateway) | **Container Apps** (autoscaling, scale-to-zero) |
| Secrets | **Key Vault** |
| Network | **VNet** + private endpoints; Container Apps → DB via private link |
| DNS | **Azure DNS** zone (you delegate) |

## Quickstart

```bash
bunx @caelo-cms/provisioning --provider azure \
  --subscription <id> \
  --resource-group caelo-prod \
  --location westeurope \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Requires `az login` as a service principal with Owner on the resource group, OR Contributor + User Access Administrator if your org enforces least-privilege.

## Notes specific to Azure

- **Front Door A/B split** — implemented via Front Door rule engine on the same FNV-1a hash as the GCP / AWS adapters, so cross-provider variant routing is byte-identical.
- **Container Apps cold-start** — comparable to Cloud Run; configure `--min-instances 1` for production.
- **Postgres flexible-server vs single-server** — adapter defaults to flexible-server (current generation). Single-server is deprecated; the adapter refuses to provision it.
- **Key Vault access policies** — the Container Apps managed identity gets `get` + `list` for the secrets the admin reads at boot. No human users are granted access by default.

## Cost (rough)

A small install lands around $65/mo on Azure:

- Azure DB flexible-server (zone-redundant, GP_Standard_D2s_v3): ~$45
- Container Apps low-traffic: ~$5
- Blob Storage + Front Door cache hits: ~$5
- Front Door + Key Vault: ~$10

## Next

- [GCP install →](/install-gcp)
- [Self-hosted →](/install-self-hosted)
