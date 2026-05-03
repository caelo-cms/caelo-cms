# Phase 15 — Cloud provisioning adapters (GCP, AWS, Azure) + per-provider edge A/B split

**Status:** ready to execute (plan v1).
**Dependencies:** P14 (Pulumi self-hosted stack + compose generators + cms-provision CLI shape), P13 (gateway hardening + cookie-anchored stable-hash A/B split + assignment-log shape), P12A (analytics plugin that consumes A/B logs), P8 (per-provider redirect generators + sitemap), P7 (storage adapter interface + CDN-copy hook).

---

## Context

P14 shipped self-hosted: a Pulumi project at `packages/provisioning/stacks/self-hosted/` that wraps the compose + Caddyfile generators behind real Pulumi resources (state, drift, `pulumi destroy` semantics). P15 lights up the same `stacks/<provider>/` shape for **GCP**, **AWS**, **Azure** — each provider is a sibling Pulumi project that reuses the cms_admin / cms_public schema, plugin host, and admin app verbatim, swapping only the *infrastructure* underneath. Operators choose `cms-provision init --provider gcp|aws|azure|self-hosted` and get the same Caelo behaviour, just running on managed cloud services instead of a single VM.

Three architectural commitments lock the shape:

1. **Single Pulumi monorepo, sibling stacks per provider.** No per-provider repository. The shared compose generators land in `packages/provisioning/src/`; per-provider Pulumi resources land in `packages/provisioning/stacks/<provider>/index.ts`. Every stack imports from the same generator helpers where applicable (Caddy → `_redirects.<provider>` file translator) and adds provider-specific resources (Cloud SQL, RDS, Azure DB) on top.

2. **Same Caelo binary on every provider.** The admin app, plugin host, gateway, orchestrator — same code. Cloud variants don't fork the runtime; they fork the *deployment surface*. A plugin written against the P11 SDK runs on every provider unchanged. Database schemas migrate identically because every provider's managed Postgres is `cms_admin` + `cms_public` with the same FORCE RLS policies.

3. **Edge A/B split is provider-native, behaviour-identical.** P13's self-hosted gateway implements stable-hash assignment via cookie + path rewrite. P15 ships **three** equivalent implementations — Cloud CDN URL maps + Cloud Run header rules (GCP), CloudFront + Lambda@Edge (AWS), Front Door rules engine (Azure) — each one reading the same `routing-manifest.json` the static generator emits and writing the same assignment-log JSON shape the P12A analytics plugin consumes. Three different runtimes, one observable contract.

---

## Architectural pivot — read this first

P15 is **not** "move Caelo to the cloud." That framing leads to per-provider adapters that drift apart over time and force us to choose-your-own-cloud at every architectural decision. The right framing: **Caelo defines a small set of infrastructure capabilities** (managed Postgres, blob storage, CDN, secret store, container runtime, CDN-edge compute), and each provider's stack maps Caelo's capabilities onto provider-native resources. The capability surface is small enough (~6 traits) that drift is bounded, and the per-provider Pulumi code is mostly orchestration, not invention.

Capability surface (defines the per-provider trait an operator must implement):

| Capability | Self-hosted (P14) | GCP (P15) | AWS (P15) | Azure (P15) |
|---|---|---|---|---|
| Managed Postgres | docker postgres + pgBackRest | Cloud SQL HA + automated backups | RDS Multi-AZ + automated snapshots | Azure DB zone-redundant + auto-backups |
| Blob storage | MinIO | GCS bucket + Cloud CDN | S3 bucket + CloudFront | Azure Blob + CDN |
| CDN | Caddy | Cloud CDN | CloudFront | Azure CDN |
| Secret store | filesystem | Secret Manager | Secrets Manager | Key Vault |
| Container runtime | docker compose on a VM | Cloud Run (admin + gateway + orchestrator + runner) | App Runner OR ECS Fargate | Container Apps |
| CDN-edge compute (A/B split + redirects) | Caddy reverse_proxy | Cloud CDN URL maps + Cloud Run | CloudFront + Lambda@Edge | Front Door rules engine |

The Caelo runtime never knows which row it's running in. All it knows is: "give me a `DATABASE_URL`, a `MEDIA_STORAGE_URL`, a `SECRETS_PROVIDER`, and an `EDGE_LOG_SINK`." Pulumi wires the right values per provider.

---

## What ships

### 1. Shared adapter contract (`packages/provisioning/src/adapter.ts`)

A single interface every provider stack implements. This file gates the abstraction so P15 doesn't accidentally build three differently-shaped APIs.

```ts
// packages/provisioning/src/adapter.ts (sketch — ~80 LOC)

export interface CloudAdapterInputs {
  /** Primary domain (e.g. example.com). Admin + production public bind here. */
  readonly domain: string;
  /** Operator email used for ACME / cert provisioning + Pulumi notifications. */
  readonly ownerEmail: string;
  /** Three-env model (§16.5). Cloud installs always provision all three. */
  readonly environments: ReadonlyArray<"dev" | "staging" | "production">;
  /** Per-locale domain config — drives per-domain cert + DNS guidance + edge routing. */
  readonly locales: ReadonlyArray<{
    code: string;
    /** "subdirectory" | "subdomain" | "domain". Mixed strategies allowed. */
    strategy: "subdirectory" | "subdomain" | "domain";
    /** Fully-qualified host for "subdomain" / "domain" strategies. */
    host?: string;
  }>;
  /** Optional: pre-existing secret references (e.g. from a CI secrets manager). */
  readonly preProvisionedSecrets?: {
    anthropicApiKey?: string;
    resendApiKey?: string;
  };
}

export interface CloudAdapterOutputs {
  /** DSN for cms_admin role; encrypted in Pulumi state. */
  readonly adminDatabaseUrl: pulumi.Output<string>;
  /** DSN for cms_public role; encrypted in Pulumi state. */
  readonly publicDatabaseUrl: pulumi.Output<string>;
  /** Provider-native blob URL (s3://, gs://, https://<account>.blob.core.windows.net/<container>). */
  readonly mediaStorageUrl: pulumi.Output<string>;
  /** Public-facing URL the admin reaches for media reads. */
  readonly mediaCdnBaseUrl: pulumi.Output<string>;
  /** Bootstrap token URL — operator opens this once after `pulumi up`. */
  readonly bootstrapUrl: pulumi.Output<string>;
  /** Rendered Pulumi.outputs.json shape consumed by the admin's DNS guidance page. */
  readonly dnsRecordsRequired: pulumi.Output<DnsRecord[]>;
  /** Where edge-A/B assignment logs land — read by the P12A analytics plugin. */
  readonly edgeLogSinkUrl: pulumi.Output<string>;
}

export interface DnsRecord {
  hostname: string;       // e.g. "de.example.com"
  type: "A" | "AAAA" | "CNAME" | "TXT";
  value: string;          // the value the operator's registrar must hold
  purpose: string;        // e.g. "subdomain locale `de` → CloudFront distribution"
}
```

Each `stacks/<provider>/index.ts` exports a function matching `(inputs: CloudAdapterInputs) => CloudAdapterOutputs`. The shared `cms-provision` CLI dispatches to the right one based on `--provider`.

### 2. GCP stack — `packages/provisioning/stacks/gcp/`

`Pulumi.yaml` + `index.ts`. Uses `@pulumi/gcp` (verify current version via context7 before pinning; expect ~v8.x) + `@pulumi/gcp-native` for resources gcp doesn't expose yet.

**Resources provisioned per environment:**
- **Cloud SQL Postgres 16, regional HA** (`google_sql_database_instance`) with `database_version: POSTGRES_16`, automated backups, point-in-time recovery, private VPC peering. Two databases (`cms_admin`, `cms_public`) + two roles (`admin_role`, `public_role`) created via post-provision migration script (reuses `packages/migrations/src/bootstrap.sh`).
- **Cloud Storage buckets** for media (`<project>-caelo-media-<env>`) + static-output (`<project>-caelo-public-<env>`). Uniform bucket-level access; `roles/storage.objectViewer` granted to the Cloud CDN service account.
- **Cloud CDN backend bucket** (static output) + **backend service** (admin + gateway running on Cloud Run). URL map routes `/api/*` → gateway, `/admin/*` → admin Cloud Run, everything else → static output bucket.
- **Cloud Run services** (admin, gateway, orchestrator, runner). Container images pulled from Artifact Registry; build pipeline lands in P15 follow-up (this PR ships the deployment shape, not the CI). For initial launch, operators push images via `gcloud builds submit`.
- **Secret Manager** entries for `postgres-password`, `minio-equivalent` (n/a — GCS replaces MinIO), `anthropic-api-key`, `resend-api-key`, `caelo-csrf-secret`, `caelo-cookie-secret`. Cloud Run services mount as env vars via `secret_environment_variables`.
- **Cloud DNS managed zone** for the primary domain + every locale subdomain. Per-locale A records point at Cloud CDN; per-locale `domain` strategies emit guidance for the operator's external registrar (we don't auto-purchase domains).
- **SSL via Google-managed certificates** — one cert per (domain, locale) pair. Cert provisioning is async; the DNS-guidance page polls `getManagedSslCertificate.status` until `ACTIVE`.
- **Cloud Logging sink** for the edge A/B assignment logs → BigQuery dataset `caelo_edge_logs`. The P12A analytics plugin reads via `bigquery.client.query()` (replaces self-hosted's direct file tail).

**Edge A/B split implementation:**
- The static generator emits `routing-manifest.json` (P6 / P13 contract) listing per-page A/B variant paths.
- Each Cloud Run admin service ships a **request-routing handler** (lives in `packages/edge-router/src/gcp.ts`, ~150 LOC) that reads the manifest at startup, hashes incoming `caelo_visitor_id` cookies (mints one if missing), assigns a variant, sets the cookie, rewrites the URL path to the variant's static-output path, and returns. Cloud CDN caches the response keyed on the cookie + URL.
- Assignment events flow into Cloud Logging via structured log entries; the BigQuery sink filters `severity=INFO AND jsonPayload.kind=ab_assignment`.

### 3. AWS stack — `packages/provisioning/stacks/aws/`

`Pulumi.yaml` + `index.ts`. Uses `@pulumi/aws` (~v7.x) + `@pulumi/awsx` for higher-level patterns.

**Resources per environment:**
- **RDS Postgres 16 Multi-AZ** with automated backups, encrypted storage, security group locked to the VPC. Two databases + two roles via the same bootstrap script.
- **S3 buckets** for media + static output. Public access blocked; CloudFront origin access identity granted read.
- **CloudFront distribution** with two origins: S3 static output (default) + ALB-fronted ECS Fargate (admin + gateway). Behaviour rules route `/api/*`, `/admin/*` to the Fargate origin; everything else hits S3 with cache TTL by content type (HTML 60s, assets 1y).
- **ECS Fargate services** for the four runtimes. Task definitions read from environment-variable secrets backed by Secrets Manager. Application Load Balancer in front; ACM cert per (domain, locale).
- **Secrets Manager** entries (same set as GCP). IAM task role grants `secretsmanager:GetSecretValue` for the matching ARN prefix only.
- **Route 53 hosted zone** for the primary domain + locale subdomains. Per-domain ACM certs requested via DNS validation; the DNS-guidance page reports cert status via `acm.describeCertificate`.
- **CloudWatch Logs** group for the assignment logs → Kinesis Firehose → S3 (queryable via Athena). The P12A plugin's AWS adapter reads via `athena.startQueryExecution`.

**Edge A/B split:**
- **CloudFront + Lambda@Edge function** (`packages/edge-router/src/aws.ts`, ~120 LOC) installed at the `viewer-request` event. Reads `caelo_visitor_id` cookie, mints + sets if missing, hashes against the manifest's variant config, rewrites `request.uri`, returns. Manifest is bundled into the Lambda deployment package on every redeploy (bundle is small; <1 MB).
- Lambda@Edge writes `console.log({kind: 'ab_assignment', ...})` to its log group; CloudWatch → Kinesis Firehose → S3 → Athena. Same JSON shape as GCP.

### 4. Azure stack — `packages/provisioning/stacks/azure/`

`Pulumi.yaml` + `index.ts`. Uses `@pulumi/azure-native` (~v3.x).

**Resources per environment:**
- **Azure Database for PostgreSQL flexible server**, zone-redundant, geo-backup. Two databases + two roles via bootstrap script.
- **Azure Storage account** with two containers (media + static output). Static output container set to `$web` for static-website hosting.
- **Azure Front Door Standard** with two origins: static-output blob + Container Apps (admin + gateway). Routes match `/api/*`, `/admin/*` to Container Apps; everything else to blob origin.
- **Azure Container Apps** for the four runtimes. Secrets bound from Key Vault via managed identity.
- **Key Vault** entries (same set). Container App's managed identity granted `get`/`list` on secrets.
- **Azure DNS zone** for the primary domain + locale subdomains. Front Door provides automatic cert management for managed domains.
- **Log Analytics workspace** receives Front Door access logs. The P12A plugin's Azure adapter queries via `monitorQuery.queryWorkspace`.

**Edge A/B split:**
- **Front Door Rules Engine** rules (`packages/edge-router/src/azure.ts`, ~100 LOC of rule-emission TypeScript that builds the rules-engine config Pulumi installs). Each rule matches a request URL prefix from the manifest, reads the `caelo_visitor_id` cookie, mints if absent, hashes, and rewrites `forwardingProtocol` + `customForwardingPath` to the variant origin path.
- Rules emit a custom log dimension on every request; the Log Analytics workspace surfaces it for the P12A plugin's `monitorQuery` calls.

### 5. Per-provider redirect generator (`packages/provisioning/src/redirects-emit.ts`)

P8 ships a redirects generator for self-hosted (Caddy `_redirects` snippet). P15 extends with three sibling functions:

```ts
export interface RedirectRow { fromPath: string; toPath: string; statusCode: 301 | 302 | 307 | 308 }

/** Cloudflare Pages format (also works for any platform that consumes _redirects). */
export function emitRedirectsCloudflare(rows: RedirectRow[]): string;

/** CloudFront via Lambda@Edge — emits a JSON config the L@E function reads at startup. */
export function emitRedirectsCloudFront(rows: RedirectRow[]): { jsonConfig: string; lambdaSource: string };

/** Azure Front Door rules engine — emits a Pulumi-compatible RuleEngineRule[] config. */
export function emitRedirectsAzureFrontDoor(rows: RedirectRow[]): unknown[];
```

The deploy step calls the right one per provider, uploads to the right place (S3 for CloudFront L@E config, Front Door rule engine for Azure, file in static-output for self-hosted Caddy + Cloudflare Pages).

### 6. Per-provider CDN-copy adapter (`packages/provisioning/src/cdn-copy.ts`)

P7 ships the `media_assets.usage_count` threshold + the `media.set_cdn` op that flips a per-asset boolean. P15 wires the actual copy:

```ts
export interface CdnCopyAdapter {
  /** Mark `assetKey` (object key in primary storage) as CDN-cached. Returns the public CDN URL. */
  pin(assetKey: string): Promise<string>;
  /** Reverse — drop from CDN edge cache. */
  unpin(assetKey: string): Promise<void>;
}
```

Three implementations: `s3-cloudfront-prewarm.ts` (issues a CloudFront cache invalidation + warm request), `gcs-cloud-cdn-pin.ts` (sets `Cache-Control: public, max-age=31536000` metadata via `gcs.objects.update`), `azure-blob-cdn-prefetch.ts` (calls Front Door's purge + warm endpoint).

Wired into the redeploy-orchestrator's existing `cdnCopyTick()` (currently a no-op stub for cloud installs); on cloud installs, the orchestrator dispatches to the right adapter based on `process.env.CAELO_PROVIDER`.

### 7. DNS guidance admin page (`apps/admin/src/routes/(authed)/security/dns/+page.svelte`)

New Owner-only route. Reads required-DNS records from Pulumi outputs (stored in `cms_admin.provisioning_outputs` table after `pulumi up`; new migration 0046) and renders:

```
example.com           CNAME   d111111abcdef.cloudfront.net.       Primary admin + production
de.example.com        CNAME   d111111abcdef.cloudfront.net.       German locale (subdomain)
example.de            CNAME   d111111abcdef.cloudfront.net.       German locale (domain)
example.com           TXT     v=acme-challenge=…                  ACM cert validation (one-time)
```

Each row gets a "copy" button + a live status badge (`ok` / `pending` / `mismatch` / `not configured`) computed by a per-row resolver check. The check uses `node:dns/promises` — same approach P14's `domains.verify` op already uses.

New ops:
- `provisioning_outputs.set` (system-only) — Pulumi calls this via a small `pulumi-output-sync` script after `pulumi up`, writing the rendered output JSON to `cms_admin.provisioning_outputs`.
- `provisioning_outputs.get` (open read) — admin UI consumes.
- `dns.verify_record` (open read) — runs the per-record resolver check.

### 8. Migration 0046 — `provisioning_outputs` + edge-log schema

```sql
-- 0046_p15_provisioning_outputs.sql
CREATE TABLE provisioning_outputs (
  id              int PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  provider        text NOT NULL CHECK (provider IN ('self-hosted','gcp','aws','azure')),
  environment     text NOT NULL CHECK (environment IN ('dev','staging','production')),
  outputs_json    jsonb NOT NULL,
  -- Hash of outputs_json so the admin UI can detect "stale snapshot" + prompt
  -- a re-sync after `pulumi up`.
  outputs_hash    text NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_outputs_unique UNIQUE (provider, environment)
);

ALTER TABLE provisioning_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisioning_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provisioning_outputs_authed ON provisioning_outputs;
CREATE POLICY provisioning_outputs_authed ON provisioning_outputs
  USING (current_setting('caelo.actor_kind', true) IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

-- The shared edge A/B assignment log shape — same schema across providers.
-- For self-hosted P13 this lives in cms_public; for cloud installs the
-- provider-native sink (BigQuery / Athena / Log Analytics) holds the
-- canonical copy and the analytics plugin queries that. We mirror a
-- materialised aggregate into cms_admin for the dashboard so the admin
-- UI doesn't need provider creds.
CREATE TABLE ab_assignment_aggregates (
  experiment_id   uuid NOT NULL,
  variant_label   text NOT NULL,
  bucket_hour     timestamptz NOT NULL,    -- truncate(updated_at, 'hour')
  impressions     bigint NOT NULL DEFAULT 0,
  conversions     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, variant_label, bucket_hour)
);
CREATE INDEX ab_assignment_aggregates_recent_idx
  ON ab_assignment_aggregates (experiment_id, bucket_hour DESC);

ALTER TABLE ab_assignment_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ab_assignment_aggregates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ab_assignment_aggregates_authed ON ab_assignment_aggregates;
CREATE POLICY ab_assignment_aggregates_authed ON ab_assignment_aggregates
  USING (current_setting('caelo.actor_kind', true) IS NOT NULL);
```

### 9. CLI dispatch (`packages/provisioning/src/cli.ts` extension)

Extend the existing `cms-provision` CLI:

```bash
cms-provision init --provider gcp     --domain example.com --owner-email me@example.com --gcp-project caelo-prod
cms-provision init --provider aws     --domain example.com --owner-email me@example.com --aws-region us-east-1
cms-provision init --provider azure   --domain example.com --owner-email me@example.com --azure-subscription <id>
cms-provision up                       # re-runs `pulumi up` against the active stack
cms-provision pulumi-output-sync       # invoked from a Pulumi post-deploy step; writes outputs into provisioning_outputs
```

`init` now writes `.caelo/provider.json` recording the chosen provider so subsequent commands route correctly. `up` reads `provider.json` and dispatches to the right `stacks/<provider>/` directory.

### 10. Edge router shared package (`packages/edge-router/`)

New workspace package. Hosts the three edge implementations (`gcp.ts`, `aws.ts`, `azure.ts`) plus a shared `manifest.ts` (load/parse the routing manifest) and `assignment.ts` (the deterministic stable-hash function — must produce byte-identical results across all four runtimes including the P13 self-hosted gateway). Tests assert byte-identical assignment for a fixed corpus of (visitorId, manifestVersion) → variantLabel.

---

## Composition rules + safety

1. **One Pulumi project per provider, never per environment.** Each provider stack supports the three environments via Pulumi's stack model (`pulumi stack init prod`, `pulumi stack init staging`, etc.). Stack names are `<provider>-<env>`. This keeps Pulumi's state graphs from bloating into `gcp-prod-de.example.com-cert` etc.

2. **Per-locale SSL is provider-managed where possible.** GCP/Azure both auto-provision certs for managed domains. AWS requires explicit ACM cert per domain — the stack creates one per `locales[]` entry whose strategy is `subdomain` or `domain`.

3. **Mixed URL strategies are the default.** Operators commonly run `en` on the primary domain (no prefix), `de` on a subdirectory, `fr` on a subdomain, `jp` on a separate domain — all simultaneously. The DNS-guidance page surfaces the records each strategy needs; the edge router reads the same routing manifest and dispatches accordingly.

4. **Patroni for self-hosted is documented, not shipped as a Pulumi resource.** Cloud installs get HA "for free" via managed Postgres. Self-hosted operators who want HA follow a runbook in `docs/operating-self-hosted.md` (P14 already references this); P15 extends the runbook with a Patroni recipe.

5. **The runtime never hardcodes a provider.** `process.env.CAELO_PROVIDER` is a hint for the orchestrator + the analytics plugin's log adapter; everything else flows from `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars set by the per-provider stack.

6. **Migrations run identically.** `bun run db:migrate` works against any provider's Postgres. The bootstrap script is the same; only the connection string differs.

7. **Secrets never leave the secret store.** Cloud Run / Fargate / Container Apps mount secrets as env vars at runtime; the admin app never reads or writes the underlying secret manager. Rotation is operator-driven via Pulumi (`pulumi config set --secret`).

8. **Edge-log writes never block requests.** All three providers are write-async (Cloud Logging buffer / CloudFront log buffer / Front Door log buffer). The P12A analytics plugin reads from the materialised aggregate table for dashboard queries; raw log queries are an Owner-only Advanced view.

---

## Critical files

**New (packages):**
- `packages/provisioning/src/adapter.ts` — shared `CloudAdapterInputs` / `CloudAdapterOutputs` interfaces.
- `packages/provisioning/src/redirects-emit.ts` — three sibling redirect generators.
- `packages/provisioning/src/cdn-copy.ts` — `CdnCopyAdapter` interface + three impls (`s3-cloudfront-prewarm.ts`, `gcs-cloud-cdn-pin.ts`, `azure-blob-cdn-prefetch.ts`).
- `packages/provisioning/stacks/gcp/Pulumi.yaml` + `index.ts` + `README.md`.
- `packages/provisioning/stacks/aws/Pulumi.yaml` + `index.ts` + `README.md`.
- `packages/provisioning/stacks/azure/Pulumi.yaml` + `index.ts` + `README.md`.
- `packages/edge-router/` — new workspace package: `package.json`, `src/manifest.ts`, `src/assignment.ts`, `src/gcp.ts`, `src/aws.ts`, `src/azure.ts`, `src/index.test.ts`.

**New (admin-core ops):**
- `packages/admin-core/src/ops/provisioning_outputs.ts` — `provisioning_outputs.set / get`.
- `packages/admin-core/src/ops/dns.ts` — `dns.verify_record`.

**New (admin UI):**
- `apps/admin/src/routes/(authed)/security/dns/+page.svelte` + `+page.server.ts` — Owner DNS guidance.
- `apps/admin/src/routes/(authed)/security/+page.svelte` — add "DNS records" tile.

**New (migration):**
- `packages/migrations/migrations/cms_admin/0046_p15_provisioning_outputs.sql` — `provisioning_outputs` + `ab_assignment_aggregates`.

**Modified:**
- `packages/provisioning/src/cli.ts` — extend with `--provider gcp|aws|azure` dispatch + `pulumi-output-sync` subcommand.
- `packages/admin-core/src/register.ts` — register new ops.
- `packages/admin-core/src/ops/media.ts` — wire `media.set_cdn` to dispatch to the right `CdnCopyAdapter` per `CAELO_PROVIDER`.
- `packages/redeploy-orchestrator/src/index.ts` — add `cdnCopyTick()` that drains the per-asset CDN-pin queue.
- `packages/admin-core/src/ai/chat-runner.ts` — extend `## Cloud install` system-prompt block with current provider + DNS-record-mismatch warnings (so the AI offers to walk the operator through fixing them).
- `package.json` workspace globs — pick up `packages/edge-router/`.

---

## Verification

End-to-end after the PR lands:

1. **`bun run typecheck && bun test && bun run lint && bun run license:check`** — all green. New `@pulumi/gcp`, `@pulumi/aws`, `@pulumi/azure-native` deps added — confirm Apache-2.0 license per package.

2. **Per-provider provisioning smoke (nightly, opt-in to CI due to cost — gated by `CAELO_RUN_CLOUD_E2E=1`):**
   - GCP: `cms-provision init --provider gcp --gcp-project <test-project> --domain caelo-test.example.com` → `pulumi up` against three stacks (dev/staging/production) → all three serve `https://caelo-test.example.com/` with valid certs → staging response carries `X-Robots-Tag: noindex`.
   - AWS: same shape; `pulumi up` against `aws-prod`/`aws-staging`/`aws-dev` → CloudFront distribution serves; ACM cert valid; Lambda@Edge function deployed; A/B split tested with 100 synthetic visitors → assignment proportions match expected ±5%.
   - Azure: same shape; Front Door provisioned; rules engine installs the A/B rules; test visitor cookie persists across requests.

3. **Mixed URL strategy on every provider:**
   - Seed three locales: `en` (no prefix), `de` (subdirectory), `fr` (subdomain `fr.caelo-test.example.com`), `jp` (domain `caelo-test.example.jp`).
   - `bunx cms-provision regenerate-edge-routing` rebuilds the routing manifest.
   - All four locale URLs resolve correctly on each provider.
   - DNS guidance page shows the four required records per provider; resolver check flags `pending` until DNS propagates, then `ok`.

4. **Per-provider redirect generator validation:**
   - Seed 3 redirects: `/old → /new (301)`, `/blog/2024 → /blog (302)`, `/legacy/* → /modern (308)`.
   - Per-provider deploy emits the right format (CloudFront L@E JSON / Front Door rule engine / Cloudflare `_redirects`).
   - Issue requests against each — every redirect returns the right status + Location.

5. **CDN-copy adapter end-to-end per provider:**
   - Upload an image via admin → `media.set_cdn` flips the asset's CDN flag → next request to the public URL serves from the CDN origin (verify via response headers: `x-served-by` / `x-cache` / `via` headers per provider).
   - Disable CDN for the asset → flag flips → request now serves from origin storage (no CDN headers).

6. **A/B split — single visitor, multiple providers:**
   - Same visitor cookie tested against all three providers' staging — gets the same variant assignment on each (the stable-hash function in `packages/edge-router/src/assignment.ts` is byte-identical).
   - Assignment events flow into the right provider's log sink; the materialised aggregate in `ab_assignment_aggregates` populates within 5 min on each.
   - Experiments dashboard (P12A) renders identical per-variant data regardless of provider.

7. **DNS guidance page correctness:**
   - Pulumi-output-sync writes `provisioning_outputs.outputs_json`.
   - Admin loads `/security/dns` → table renders correct hostnames + values + status.
   - Manually break a DNS record (delete the A record at the registrar) → status flips to `mismatch` within 30s of next page load.

8. **Bootstrap token flow on cloud:**
   - `pulumi up` provisions infra + emits `bootstrapUrl` Pulumi output.
   - Operator opens the URL → /setup gates on the bootstrap token (P14 review-pass A pattern) → first owner created.

9. **Cross-provider parity test:** the same admin-core test suite (497 tests) passes against a Postgres connection string from any of the four providers.

---

## Deferred (intentionally NOT in this PR)

- **CI/CD pipeline for container image builds.** Operators push images via `gcloud builds submit` / `aws ecr get-login-password` / `az acr build` for v1. A unified `cms-provision build-images` subcommand lands in P15 review pass — needs deeper thought about cross-arch builds + signing.

- **Auto-rotation of secrets.** Manual rotation via `pulumi config set --secret` works for v1. Auto-rotation per-provider lands as a follow-up; the secret-fetch path on the runtime side already pulls fresh values per request.

- **Cross-region failover.** v1 single-region per environment. Multi-region active-active or active-passive is its own project — needs a real customer signal first.

- **Provider-specific cost dashboards.** P16's AI cost dashboard already covers AI spend per provider. Infra spend (Cloud SQL hours, S3 storage, etc.) is the cloud console's job for v1; a unified Caelo billing rollup is a polish-pass concern.

- **Marketplace listings (GCP Marketplace / AWS Marketplace / Azure Marketplace).** Listing artifacts + the certification process (~weeks per provider) live outside the OSS release; ship plain Pulumi v1, marketplace later.

- **Patroni shipped as a Pulumi resource for self-hosted.** Self-hosted HA stays runbook-only per master plan.

- **Edge-router unit tests against real cloud edge.** v1 ships fixture-driven byte-identity tests for the assignment hash. Real-edge test runs are part of the nightly cloud-e2e suite (#2 above).

---

## Open questions to resolve before code starts

1. **Lambda@Edge deployment region constraint.** Lambda@Edge functions must be created in `us-east-1` regardless of the operator's CloudFront region. The AWS stack has to special-case the cert + function provider region. Resolved: `provider: aws.regions.UsEast1` for the L@E function only; everything else respects `--aws-region`.

2. **Cloud Run cold-start latency on a fresh deploy.** First request after a deploy can be 2-5 s. v1 plan: enable `min-instances=1` for production (~$30/mo per service). Operators can drop to 0 for dev/staging. Document in the GCP runbook.

3. **Azure Container Apps regional availability.** Container Apps isn't available in all Azure regions. Stack errors loudly during preview if the chosen region doesn't support it; v1 pin a list of supported regions in `stacks/azure/regions.ts`.

4. **Per-provider cert auto-renewal.** Google + Azure auto-renew managed certs. ACM auto-renews validated DNS certs. v1 doesn't add monitoring; if a cert expires, the DNS guidance page's resolver check catches it.

5. **The routing manifest's variant URL paths.** v1 plan: variant paths are `/page-slug` for control + `/_caelo-variant/<experimentId>/<variantLabel>/page-slug` for variants. Edge router rewrites cookied visitors to the variant path; static generator emits both files at deploy. Alternative considered: query string (`?_caelo_v=B`) — rejected because some CDNs cache-key strip query strings by default.

---

## Effort + sequencing

**Effort: ~50 hr** spread across three focused PRs (one per provider) plus the shared scaffolding PR. Realistic ship-window: ~1.5 weeks of focused work.

Recommended sequence:

1. **Shared scaffolding PR (~10 hr):** `adapter.ts`, `redirects-emit.ts`, `cdn-copy.ts` interfaces, `packages/edge-router/` with the shared assignment hash + manifest loader, migration 0046, `provisioning_outputs` ops, DNS guidance UI, CLI extension shape. Lands without any provider-specific code; the existing self-hosted stack continues to work.
2. **AWS PR (~14 hr):** highest-value provider for OSS launch (most operators); proves the L@E A/B split works end-to-end.
3. **GCP PR (~13 hr):** validates the abstraction by showing a second runtime (Cloud Run vs Fargate) hits the same shape.
4. **Azure PR (~13 hr):** completes the trio; validates the third runtime (Container Apps vs Cloud Run vs Fargate).

Each provider PR is ~13-14 hr of mostly Pulumi-resource definition + the per-provider edge router implementation (~120-150 LOC each).

---

## Recommendation

Ship as four sequential PRs over one milestone window. The shared scaffolding PR is low-risk and unblocks the three provider PRs without dependencies between them — once shared lands, GCP/AWS/Azure can land in any order (or in parallel if the contributor base allows).

The biggest risk is **edge-router behaviour drift** between the four implementations (self-hosted P13 + three cloud). Mitigation: the shared `packages/edge-router/src/assignment.ts` ships byte-identity tests that all four implementations import + assert against. Any drift surfaces in CI before a real visitor sees a stale assignment.

Second risk: **cloud-e2e tests are expensive.** Mitigation: gated behind `CAELO_RUN_CLOUD_E2E=1` so day-to-day CI stays fast; nightly run in a single dedicated test project per provider (~$50/mo total infra burn for a always-on dev stack). The provider stacks all support `pulumi destroy` cleanly so we can spin up + tear down on every test run if the always-on cost matters.

Third risk: **Pulumi state corruption from a half-failed `pulumi up`.** Pulumi handles this via state-locking + retry-on-failure semantics; the operator runbook documents `pulumi cancel` + `pulumi refresh` as the recovery path.
