# Caelo AWS provider stack

Pulumi stack provisioning Caelo on AWS managed services. Implements the shared `CloudAdapterInputs` / `CloudAdapterOutputs` contract from `packages/provisioning/src/adapter.ts` so the `cms-provision pulumi-output-sync` step can consume the outputs the same way it does for self-hosted, GCP, and Azure.

## What it provisions per environment

| Concern | AWS resource |
|---|---|
| Managed Postgres | RDS Postgres 16 Multi-AZ + automated backups + encryption (`db.t4g.small` default) |
| Connection budget | `max_connections` pinned by a parameter group (`maxConnections`, default 100); the pool sizes for `adminMaxInstances` 5 / `gatewayMaxInstances` 10 are exported as `poolBudgetEnvOut` for the task definitions (#749): cms_admin 7, admin cms_public 4, gateway 2 per task (docs/dev/connection-budget.md) |
| Blob storage | Two S3 buckets (`caelo-<env>-media` + `caelo-<env>-static`) |
| CDN | CloudFront distribution with two origins (S3 static + S3 media); static files are served as files, no edge compute on the request path |
| Container runtime | ECS Fargate cluster + four services (admin / gateway / orchestrator / runner) |
| Secret store | AWS Secrets Manager (postgres-password, public-role-password, csrf-secret, cookie-secret, anthropic-api-key, resend-api-key). The gateway gets `publicDatabaseUrlOut` only, never a cms_admin URL of any role (#613, #635). |
| DNS + cert | ACM cert (us-east-1, DNS-validated, supports `*.<domain>`) |
| Edge-log sink | CloudFront access logs delivered to the CloudWatch log group `/caelo/<env>/cloudfront` in us-east-1 (queryable by P12A analytics plugin) |

The Caelo runtime never knows it's on AWS — it just consumes `DATABASE_URL` / `MEDIA_STORAGE_URL` / `SECRETS_PROVIDER` env vars wired by this stack.

## First-time install

Run this stack from a checkout of the Caelo repository after `bun install` at its root. `@pulumi/aws` + `@pulumi/awsx` are devDependencies of `@caelo-cms/provisioning`: the CLI wizard does not provision AWS yet, so the published package does not make every GCP and self-hosted install download them (the one-click install from Cloud Shell runs in a 5 GB home directory). They move back to `dependencies` when the AWS wizard ships.

```bash
cd packages/provisioning/stacks/aws
pulumi stack init prod
pulumi config set caelo-aws:domain example.com
pulumi config set caelo-aws:ownerEmail me@example.com
# Required (#607): fixed after install; aws:region must match.
pulumi config set caelo-aws:region eu-central-1
pulumi config set aws:region eu-central-1

# Bring the stack up.
pulumi up

# Sync outputs into cms_admin.provisioning_outputs so the admin's
# /settings/dns page shows the required DNS records.
ADMIN_DATABASE_URL=$(pulumi stack output adminDatabaseUrlOut --show-secrets) \
  bunx cms-provision pulumi-output-sync --environment production
```

The bootstrap-token URL surfaces as a Pulumi output:

```bash
pulumi stack output bootstrapUrlOut
# → https://example.com/setup?token=<64-hex>
```

Open that URL once CloudFront has issued the ACM cert (~10 minutes after DNS records propagate).

## Upgrading a stack created before #676

Stacks created before epic #676 carry a Lambda@Edge function on the CloudFront distribution. The first `pulumi up` after upgrading detaches it and then deletes it, but AWS keeps the function's edge replicas for up to a few hours after detaching and refuses the delete until they are gone. If `pulumi up` fails with `Lambda was unable to delete ... because it is a replicated function`, the distribution is already updated: wait an hour and run `pulumi up` again to finish removing the function.

## Destroy

```bash
pulumi destroy
```

Tears down all resources except S3 buckets in production (operator must run `aws s3 rm s3://… --recursive` then re-apply destroy). Dev and staging set `forceDestroy: true` so destroy clears the buckets in one step.
