---
slug: install-aws
template: doc-page
locale: en
status: published
seo:
  title: Install on AWS — Caelo CMS
  description: Deploy Caelo to AWS via Pulumi. RDS Multi-AZ + S3 + CloudFront + Lambda + Secrets Manager.
---

# Install — Amazon Web Services

The `--provider aws` adapter mirrors the GCP shape on AWS-equivalent services.

| Layer | AWS service |
|---|---|
| Database | **RDS Postgres 16** (Multi-AZ) |
| Object storage | **S3** (one public + one private bucket) |
| Edge | **CloudFront** with ACM-managed cert |
| Compute (admin + gateway) | **API Gateway + Lambda** (or Fargate for higher concurrency) |
| Secrets | **Secrets Manager** |
| Network | **VPC** + private subnets; Lambda → RDS via VPC endpoints |
| DNS | **Route 53** zone (you delegate) |

## Quickstart

```bash
bunx @caelo/provisioning --provider aws \
  --account 123456789012 \
  --region eu-central-1 \
  --domain caelo.example.com \
  --owner-email you@example.com \
  --anthropic-key sk-ant-...
```

Required: AWS credentials with the IAM permissions the adapter declares (visible in the dry-run preview the provisioner prints before applying).

## Notes specific to AWS

- **Cold-start sensitivity** — Lambda is cheaper than Fargate but cold-starts are 1–2s for the admin's first request after idle. For low-traffic installs this is fine; busy installs should switch to Fargate via `--compute fargate`.
- **CloudFront cache behaviour** — the static-generated pages cache aggressively (24h default); the admin + gateway routes are pass-through with `Cache-Control: no-store`. The provisioner configures both.
- **A/B edge split** — the gateway uses a Lambda@Edge function to compute the FNV-1a hash and route to the right variant; assignment logs land in CloudWatch and feed the analytics plugin.
- **Secrets rotation** — the admin reads Secrets Manager via env vars at boot; rotating a secret requires a Lambda redeploy (~30s). The provisioner handles this for you on `bunx @caelo/provisioning rotate-secret <name>`.

## Cost (rough)

A small install on AWS lands around $55/mo:

- RDS `db.t4g.micro` Multi-AZ: ~$30
- Lambda (low traffic): ~$3
- S3 + CloudFront with cache hits: ~$5
- Route 53 + ACM cert: ~$1
- VPC NAT Gateway: ~$15 (the unavoidable AWS tax)

## Next

- [Azure install →](/install-azure)
- [GCP install →](/install-gcp)
