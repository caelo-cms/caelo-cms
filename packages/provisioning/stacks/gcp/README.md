# Caelo GCP provider stack

Pulumi stack provisioning Caelo on GCP managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts` so the `cms-provision pulumi-output-sync` step consumes the outputs the same way it does for self-hosted, AWS, and Azure.

## What it provisions per environment

| Concern | GCP resource |
|---|---|
| Managed Postgres | Cloud SQL Postgres 16 (REGIONAL HA in production, ZONAL elsewhere) + automated backups + PITR + private IP only |
| Blob storage | Two GCS buckets (`<project>-caelo-<env>-media`, `<project>-caelo-<env>-static`) with uniform bucket-level access |
| CDN | Global HTTPS load balancer + Cloud CDN backend bucket: `<domain>` serves the static bucket as files, `/api/*` goes to the gateway, `admin.<domain>` to the IAP-gated admin |
| Container runtime | Four Cloud Run services (admin / gateway / orchestrator / runner) |
| Secret store | Secret Manager: postgres-password (admin_role) + secret-kek (Pulumi); internal-secret, tool-approval-secret, public-role-password and gateway-role-password (created by the CLI before `pulumi up`, see `src/runtime-secrets.ts`). Cloud Run reads each as a `secretKeyRef`; database URLs carry no password. The gateway's service account reads only the two gateway role passwords (#613); `gateway_role` itself is created by migration 0248 and gets its password from the CLI after migrations. |
| Edge-log sink | Cloud Logging project sink → BigQuery dataset `<env>_edge_logs` (queryable by P12A analytics plugin) |

The Caelo runtime never knows it's on GCP — every Cloud Run service consumes plain `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars.

## First-time install

```bash
cd packages/provisioning/stacks/gcp
pulumi stack init prod
pulumi config set caelo-gcp:domain example.com
pulumi config set caelo-gcp:ownerEmail me@example.com
pulumi config set caelo-gcp:project my-gcp-project
# Required (#607): no default, fixed after install.
pulumi config set caelo-gcp:region europe-west1

# Optional: scale up beyond the safe-by-default ceiling. The defaults
# size for a small editorial install (admin maxScale 5 × Bun SQL pool
# max 10 × 2 pools = 100 conns, matching Postgres max_connections=100).
# pulumi config set caelo-gcp:adminMaxInstances 10
# pulumi config set caelo-gcp:maxConnections 200

# Build + push images. Operator does this once + on every release.
gcloud auth configure-docker us-central1-docker.pkg.dev
gcloud builds submit ... --tag us-central1-docker.pkg.dev/$PROJECT/caelo/admin:latest
# Repeat for gateway, orchestrator, runner.

# The stack references two secrets it does not create (the CLI wizard and
# `upgrade` create them; a direct `pulumi up` needs them first). Values go
# on stdin, never argv. Match --replication-policy to the stack's
# secretReplication config (`automatic` or `user-managed --locations=<region>`).
for s in internal-secret tool-approval-secret; do
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "caelo-production-$s" \
    --project=$PROJECT --replication-policy=automatic --data-file=-
done

# Bring the stack up.
pulumi up

# Sync outputs into cms_admin.provisioning_outputs so the admin's
# /security/dns page surfaces the required DNS records.
CAELO_INTERNAL_SECRET=$(gcloud secrets versions access latest \
    --secret=caelo-production-internal-secret --project=$PROJECT) \
  CAELO_ADMIN_URL=https://admin.example.com \
  bunx cms-provision pulumi-output-sync --environment production
```

The bootstrap-token URL is a Pulumi output:

```bash
pulumi stack output bootstrapUrlOut
# → https://example.com/setup?token=<64-hex>
```

Open after the domain's and the admin's DNS A records point at the load balancer IP and the managed certificate is active.

## v1 limitations (P15 review-pass items)

- **Container image build pipeline** — operators push via `gcloud builds submit` for v1. A unified `cms-provision build-images --provider gcp` lands later.
- **Per-locale managed SSL certs** — operator creates via `gcloud compute ssl-certificates create` per locale subdomain for v1. Auto-provisioning lands alongside the LB.
- **DNS records** — `dnsRecordsRequired` includes a `<gcp-load-balancer-ip>` placeholder; the DNS UI shows the right hostname/type for the operator to fill in once the LB IP exists.

## Destroy

```bash
pulumi destroy
```

Tears down all resources except buckets in production (operator removes via `gsutil rm -r gs://<bucket>` then re-applies destroy). Dev/staging set `forceDestroy: true`.
