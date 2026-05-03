---
slug: install-gcp
template: doc-page
locale: en
status: published
seo:
  title: Install on Google Cloud — Caelo CMS
  description: Deploy Caelo to GCP with one command. Cloud SQL HA + Cloud Storage + Cloud CDN + Cloud Run + Secret Manager via Pulumi.
---

# Install — Google Cloud

The `--provider gcp` adapter spins up a managed stack that mirrors the self-hosted compose stack feature-for-feature, with HA + autoscaling + managed TLS.

## What gets provisioned

| Layer | GCP service | Notes |
|---|---|---|
| Database | **Cloud SQL Postgres 16** (Regional HA) | Automatic failover, daily snapshots, 7-day PITR |
| Object storage | **Cloud Storage** | Two buckets: `<install>-static` (public, CDN-fronted) + `<install>-uploads` (private) |
| Edge | **Cloud CDN** + Load Balancer | TLS via Google-managed cert; A/B edge split honoured |
| Compute (admin + gateway) | **Cloud Run** | Autoscaling, scales to zero idle |
| Secrets | **Secret Manager** | Bearer tokens, OAuth secrets, AI provider keys |
| Network | **VPC** + Serverless VPC Access | Cloud Run → Cloud SQL via private IP only |
| DNS | **Cloud DNS** zone (you delegate NS) | Records surfaced at `/security/dns` |

## Prerequisites

- A GCP project with billing enabled
- A service account with the roles the adapter needs:
  - `roles/run.admin`, `roles/cloudsql.admin`, `roles/storage.admin`,
    `roles/secretmanager.admin`, `roles/iam.serviceAccountUser`,
    `roles/compute.networkAdmin`, `roles/dns.admin`
- The `gcloud` CLI authenticated as that service account (or `GOOGLE_APPLICATION_CREDENTIALS` pointing at its JSON key)
- A domain you control

## Run the provisioner

```bash
bunx @caelo-cms/provisioning --provider gcp \
  --project caelo-prod \
  --region europe-west1 \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Wall-clock: about 10 minutes (mostly Cloud SQL HA setup).

What you'll see:

1. Pulumi previews the stack; you confirm
2. VPC + private services connection comes up
3. Cloud SQL provisions in regional-HA mode
4. Buckets + Secret Manager seeded
5. Cloud Run services deployed
6. Load balancer + Cloud CDN configured; managed TLS cert provisions (~5 min after DNS resolves)
7. The admin migrates the schema + seeds the system actor
8. Owner-bootstrap URL printed

## DNS

The provisioner emits the exact records you need. They're surfaced at `https://caelo.example.com/security/dns` after the install — but TLS won't issue until you actually create them. Two records you'll always need:

- `A` record for `caelo.example.com` → load balancer IP
- `CNAME` for `staging.caelo.example.com` → load balancer IP

If you delegated the entire zone via `gcloud dns managed-zones create` to the install, the provisioner adds both automatically. If you kept your registrar's nameservers, copy the records from `/security/dns` and paste them at the registrar.

## Three environments

`bunx @caelo-cms/provisioning --provider gcp --env staging` brings up a parallel staging stack: separate Cloud Run service, separate Cloud SQL instance (or Cloud SQL Smaller-tier — configurable), separate `staging.caelo.example.com` host, `X-Robots-Tag: noindex` header.

Production promotion goes through the **Ops** view in the admin (`/security/deployments` → "Promote staging → production"), not via Pulumi.

## Cost (rough)

A small docs-site-shaped install runs ~$45/mo on GCP:

- Cloud SQL `db-g1-small` HA: ~$30
- Cloud Run (low traffic, scales to zero idle): ~$3
- Cloud Storage + Cloud CDN: ~$2 with cache hits
- Load balancer + IP: ~$10

Heavier installs scale Cloud Run + Cloud SQL tier; the admin's `/security/costs` aggregates AI spend separately.

## Day-2 operations

| Task | How |
|---|---|
| Apply migrations on a new release | `bunx @caelo-cms/provisioning upgrade` |
| Read logs | Cloud Logging — filter by `resource.labels.service_name="caelo-admin-prod"` |
| Restore from PITR | `gcloud sql backups restore` — see [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md) §F |
| Rotate the Anthropic key | Secret Manager → version add → admin Cloud Run service redeploys |
| Scale Cloud Run | `gcloud run services update caelo-admin-prod --max-instances=20` |

## Common issues

- **TLS cert stuck on `provisioning`** — DNS hasn't propagated. `dig caelo.example.com` should return the load balancer IP. Wait 10-30 min; Google-managed certs poll for a valid challenge.
- **`Cannot allocate memory` from Cloud SQL** — bump tier from `db-g1-small` to `db-custom-2-7680` via `gcloud sql instances patch`.
- **Cloud Run cold-starts feel slow** — set `--min-instances=1` on the admin service. Costs ~$15/mo extra; eliminates first-request latency.

## Next

- [AWS install →](/install-aws)
- [Architecture →](/architecture)
- Incident response: [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md)
