---
slug: install-azure
template: doc-page
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
  --region westeurope \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Requires `az login` as a service principal with Owner on the resource group, OR Contributor + User Access Administrator if your org enforces least-privilege.

## Region

The Azure stack requires `caelo-azure:region` (it replaces the earlier `caelo-azure:location` key; a stack that still has the old key stops and prints the two commands that move it). There is no default, so it never lands in a region nobody chose. Pick the region with care: it is fixed after install, because moving means migrating the database, storage and Key Vault. Microsoft publishes no fixed list of Container Apps regions; check yours with `az provider show --namespace Microsoft.App --query "resourceTypes[?resourceType=='managedEnvironments'].locations"`. The guided region picker that the [GCP install](/install-gcp#choosing-the-region) has, which runs this check for you, will come with the Azure provisioner flow.

## Notes specific to Azure

- **Media storage is not wired yet** — the stack creates a media bucket but does not mount persistent storage into the admin, so the admin refuses to start rather than lose uploads on the next redeploy ([#618](https://github.com/caelo-cms/caelo-cms/issues/618)).
- **Front Door A/B split** — implemented via Front Door rule engine on the same FNV-1a hash as the GCP / AWS adapters, so cross-provider variant routing is byte-identical.
- **Container Apps cold-start** — comparable to Cloud Run; configure `--min-instances 1` for production.
- **Postgres flexible-server vs single-server** — adapter defaults to flexible-server (current generation). Single-server is deprecated; the adapter refuses to provision it.
- **Key Vault access policies** — the Container Apps managed identity gets `get` + `list` for the secrets the admin reads at boot. No human users are granted access by default.

## Cost (rough)

A small install lands around $65/mo on Azure:

- Azure DB flexible-server (zone-redundant, GP_Standard_D2s_v3): ~$45
- Container Apps low-traffic: ~$5 (the admin runs with `adminMemory`, default 2 GiB / 1 vCPU, for the [quality checks](/quality-gate))
- Blob Storage + Front Door cache hits: ~$5
- Front Door + Key Vault: ~$10

## Next

- [GCP install →](/install-gcp)
- [Self-hosted →](/install-self-hosted)
