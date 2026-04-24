# Phase 15 — Cloud provisioning adapters (GCP, AWS, Azure)

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P14.

## Goal (from master plan)
Provider adapters under the same Pulumi umbrella: GCP (Cloud SQL HA, Cloud Storage + CDN, Cloud Run, Secret Manager), AWS (RDS Multi-AZ, S3 + CloudFront, API Gateway + Lambda, Secrets Manager), Azure (Azure DB zone-redundant, Blob + CDN, API Management, Key Vault). Three-environment stacks per provider. Per-locale domain/subdomain SSL and mixed URL strategy routing handled by the adapter. Provider-specific redirect file generators (Cloudflare Pages `_redirects`, CloudFront Lambda@Edge JSON, Azure Front Door rules). Per-provider CDN asset copy adapters. Admin DNS guidance page. **Per-provider edge A/B split adapters:** Cloud CDN rules / CloudFront Lambda@Edge / Azure Front Door rules implementing the same stable-hash split as P13's self-hosted gateway, with assignment logs piped into the analytics plugin. Patroni documented as opt-in HA for self-hosted.

## End-to-end verification
Same command succeeds on GCP, AWS, Azure; staging + production both serve per provider with staging noindexed; mixed URL strategy all serving; provider-specific redirect files validated; CDN-copied assets served from CDN origin; admin DNS guidance page lists the correct records and reports resolution status; **A/B edge split behaves identically across GCP / AWS / Azure — same stable-hash assignment per visitor, same logs format feeding the analytics plugin**.

## To be detailed before execution
- Shared adapter interface: `provision({ domain, environments, locales, secrets, ... }) → Outputs` (adds `environments: ('staging'|'production')[]`).
- Per-provider Pulumi packages (verify current versions): `@pulumi/gcp`, `@pulumi/aws`, `@pulumi/azure-native`.
- Per-locale SSL: cert per domain/subdomain; provisioner records required DNS records; admin UI surfaces them.
- **Redirect file generator extensions:** `_redirects` for Cloudflare Pages, Lambda@Edge JSON for CloudFront, Azure Front Door rules — plug into the P8 generator interface.
- **CDN asset copy adapters** (per provider) — S3→CloudFront prewarm, GCS→Cloud CDN pin, Azure Blob→CDN prefetch; driven by the `media_assets.usage_count` threshold from P7.
- Storage adapter implementations (S3, GCS, Azure Blob) land here — interface defined in P7.
- Secrets manager adapters (Secret Manager, Secrets Manager, Key Vault) — interface defined in P5.
- **DNS guidance admin page:** reads required records from the Pulumi outputs store; shows copyable values per locale domain; runs a resolver check and reports `ok`/`pending`/`mismatch`.
- **A/B edge split per provider:**
  - Shared contract: every adapter reads the P6 `routing-manifest.json` + experiment config and installs provider-native split rules that implement the same stable-hash behaviour as the self-hosted P13 gateway.
  - GCP: Cloud CDN + Cloud Run request routing rules keyed on a cookie-assigned bucket.
  - AWS: CloudFront + Lambda@Edge function that reads / sets the assignment cookie and rewrites the origin path.
  - Azure: Front Door rules engine implementing the same cookie-stamp + path-rewrite flow.
  - All three providers emit the same log format consumed by the P12A analytics plugin; the Experiments dashboard is provider-agnostic.
- End-to-end provisioning integration tests per provider (nightly, optional in CI due to cost).
