# Caelo AWS provider stack

Pulumi stack provisioning Caelo on AWS managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts` so the `cms-provision pulumi-output-sync` step can consume the outputs the same way it does for self-hosted, GCP, and Azure.

## What it provisions per environment

| Concern | AWS resource |
|---|---|
| Managed Postgres | RDS Postgres 16 Multi-AZ + automated backups + encryption (`db.t4g.small` default) |
| Blob storage | Two S3 buckets (`caelo-<env>-media` + `caelo-<env>-static`) |
| CDN | CloudFront distribution with two origins (S3 static + S3 media) |
| Edge compute (A/B + redirects) | Lambda@Edge function (us-east-1 pinned) on `viewer-request` |
| Container runtime | ECS Fargate cluster + four services (admin / gateway / orchestrator / runner) |
| Secret store | AWS Secrets Manager (postgres-password, csrf-secret, cookie-secret, anthropic-api-key, resend-api-key) |
| DNS + cert | ACM cert (us-east-1, DNS-validated, supports `*.<domain>`) |
| Edge-log sink | CloudWatch Logs → Kinesis Firehose → S3 → Athena (queryable by P12A analytics plugin) |

The Caelo runtime never knows it's on AWS — it just consumes `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars wired by this stack.

## First-time install

```bash
cd packages/provisioning/stacks/aws
pulumi stack init prod
pulumi config set caelo-aws:domain example.com
pulumi config set caelo-aws:ownerEmail me@example.com
pulumi config set caelo-aws:region us-east-1

# Build the Lambda@Edge bundle BEFORE the first `pulumi up`.
bun run packages/provisioning/stacks/aws/build-edge.ts

# Bring the stack up.
pulumi up

# Sync outputs into cms_admin.provisioning_outputs so the admin's
# /security/dns page shows the required DNS records.
ADMIN_DATABASE_URL=$(pulumi stack output adminDatabaseUrlOut --show-secrets) \
  bunx cms-provision pulumi-output-sync --environment production
```

The bootstrap-token URL surfaces as a Pulumi output:

```bash
pulumi stack output bootstrapUrlOut
# → https://example.com/setup?token=<64-hex>
```

Open that URL once CloudFront has issued the ACM cert (~10 minutes after DNS records propagate).

## Updating the routing manifest

Lambda@Edge has no DB egress — the routing manifest is bundled into the function source. After every static-generator deploy that changes routing, re-run:

```bash
bun run packages/provisioning/stacks/aws/build-edge.ts \
  --manifest apps/static-generator/dist/routing-manifest.json
pulumi up
```

L@E versions are immutable; each `pulumi up` after a manifest change creates a new published version + repoints CloudFront's behaviour.

## Lambda@Edge constraints worth knowing

- **Region pinned to us-east-1.** Code lives in us-east-1 regardless of where CloudFront's origins are. The stack creates a separate `us-east-1` Pulumi provider just for L@E.
- **1 MB unzipped limit.** The build script warns when the bundle exceeds it.
- **No env vars at runtime.** Anything the function needs must be bundled in.
- **5-second timeout** at viewer-request. Caelo's edge-router is pure code — well under this.
- **No async I/O** at viewer-request. The `routeRequest` helper is synchronous-after-import; logging via `console.log` is async-fire-and-forget.

## Edge-router byte-identity

This stack imports `routeRequest` from `@caelo/edge-router` — the same function the P13 self-hosted Caddy gateway, the GCP Cloud Run handler (P15), and the Azure Front Door rules engine (P15) use. The byte-identity test in `packages/edge-router/src/index.test.ts` asserts that a fixed corpus of (visitorId, manifestVersion, experimentId) tuples produces identical variant labels across every runtime — a visitor sees the same variant whether they hit the self-hosted Caddy in dev or the AWS CloudFront in production.

## Destroy

```bash
pulumi destroy
```

Tears down all resources except S3 buckets in production (operator must run `aws s3 rm s3://… --recursive` then re-apply destroy). Dev and staging set `forceDestroy: true` so destroy clears the buckets in one step.
