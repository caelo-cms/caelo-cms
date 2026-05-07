# Caelo GCP provider stack

Pulumi stack provisioning Caelo on GCP managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts` so the `cms-provision pulumi-output-sync` step consumes the outputs the same way it does for self-hosted, AWS, and Azure.

## What it provisions per environment

| Concern | GCP resource |
|---|---|
| Managed Postgres | Cloud SQL Postgres 16 (REGIONAL HA in production, ZONAL elsewhere) + automated backups + PITR + private IP only |
| Blob storage | Two GCS buckets (`<project>-caelo-<env>-media`, `<project>-caelo-<env>-static`) with uniform bucket-level access |
| CDN | Cloud CDN backend bucket (operator wires the URL map + load balancer for v1; full LB in P15 review-pass) |
| Edge compute (A/B + redirects) | Cloud Run service `<env>-edge-router` running `edge-handler.ts` with `@caelo-cms/edge-router` |
| Container runtime | Four Cloud Run services (admin / gateway / orchestrator / runner) |
| Secret store | Secret Manager (postgres-password, csrf-secret, cookie-secret, anthropic-api-key, resend-api-key) |
| Edge-log sink | Cloud Logging project sink → BigQuery dataset `<env>_edge_logs` (queryable by P12A analytics plugin) |

The Caelo runtime never knows it's on GCP — every Cloud Run service consumes plain `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars.

## First-time install

```bash
cd packages/provisioning/stacks/gcp
pulumi stack init prod
pulumi config set caelo-gcp:domain example.com
pulumi config set caelo-gcp:ownerEmail me@example.com
pulumi config set caelo-gcp:project my-gcp-project
pulumi config set caelo-gcp:region us-central1

# Optional: scale up beyond the safe-by-default ceiling. The defaults
# size for a small editorial install (admin maxScale 5 × Bun SQL pool
# max 10 × 2 pools = 100 conns, matching Postgres max_connections=100).
# pulumi config set caelo-gcp:adminMaxInstances 10
# pulumi config set caelo-gcp:maxConnections 200

# Build + push images. Operator does this once + on every release.
gcloud auth configure-docker us-central1-docker.pkg.dev
gcloud builds submit ... --tag us-central1-docker.pkg.dev/$PROJECT/caelo/admin:latest
# Repeat for gateway, orchestrator, runner, edge-router.

# Bring the stack up.
pulumi up

# Sync outputs into cms_admin.provisioning_outputs so the admin's
# /security/dns page surfaces the required DNS records.
ADMIN_DATABASE_URL=$(pulumi stack output adminDatabaseUrlOut --show-secrets) \
  bunx cms-provision pulumi-output-sync --environment production
```

The bootstrap-token URL is a Pulumi output:

```bash
pulumi stack output bootstrapUrlOut
# → https://example.com/setup?token=<64-hex>
```

Open after the operator has wired the GCP HTTPS load balancer to the edge-router Cloud Run service + the admin's DNS A record points at the LB IP.

## Edge-router behaviour

This stack's `edge-handler.ts` imports `routeRequest` from `@caelo-cms/edge-router` — same function the AWS Lambda@Edge function and the P13 self-hosted Caddy gateway use. Differences from AWS L@E:

- **Manifest lives in GCS, not bundled in the binary.** The handler fetches `gs://<static-bucket>/routing-manifest.json` on a 30s TTL cache. A new manifest takes effect within 30s without a Cloud Run redeploy.
- **Returns 307 redirects** (instead of L@E's request-mutation rewrite) so the browser hits the variant URL directly + the static origin's cache respects the variant cache key.
- **Sets the `caelo_visitor_id` cookie directly** in the response (Cloud Run handlers control headers; L@E's viewer-request cannot).
- **Cloud Logging → BigQuery**, not CloudWatch → Athena. Same `{kind: "ab_assignment", ...}` JSON shape.

## v1 limitations (P15 review-pass items)

- **GCP HTTPS load balancer + URL map** not auto-provisioned. Operator wires the LB to point `/api/*` → gateway, `/admin/*` → admin, `/_caelo-variant/*` → static bucket directly, and everything else → edge-router. Auto-provisioning lands when telemetry shows operators want it.
- **Container image build pipeline** — operators push via `gcloud builds submit` for v1. A unified `cms-provision build-images --provider gcp` lands later.
- **Per-locale managed SSL certs** — operator creates via `gcloud compute ssl-certificates create` per locale subdomain for v1. Auto-provisioning lands alongside the LB.
- **DNS records** — `dnsRecordsRequired` includes a `<gcp-load-balancer-ip>` placeholder; the DNS UI shows the right hostname/type for the operator to fill in once the LB IP exists.

## Edge-router byte-identity

The byte-identity test in `packages/edge-router/src/index.test.ts` asserts a fixed corpus of (visitorId, manifestVersion, experimentId) tuples produces identical variant labels across every runtime — a visitor sees the same variant whether they hit the self-hosted Caddy in dev, the AWS CloudFront in staging, or the GCP Cloud Run in production.

## Destroy

```bash
pulumi destroy
```

Tears down all resources except buckets in production (operator removes via `gsutil rm -r gs://<bucket>` then re-applies destroy). Dev/staging set `forceDestroy: true`.
