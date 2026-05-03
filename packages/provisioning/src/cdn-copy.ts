// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — per-provider CDN-copy adapter contract.
 *
 * P7 ships the `media_assets.usage_count` threshold + the `media.set_cdn`
 * op that flips a per-asset boolean. P15 wires the actual edge-pin
 * operation per provider:
 *   - AWS  → CloudFront cache invalidation + warmer request.
 *   - GCP  → set Cache-Control metadata on the GCS object so Cloud CDN
 *           respects the long TTL.
 *   - Azure → Front Door purge + warm endpoint.
 *
 * The redeploy-orchestrator's `cdnCopyTick()` (currently a no-op for
 * cloud installs) drains the per-asset CDN-pin queue using the adapter
 * registered for the active provider.
 *
 * Each provider's stack publishes a `CdnCopyAdapter` instance via its
 * Pulumi outputs (the actual implementation is dynamically imported by
 * the orchestrator at runtime so `@caelo/provisioning` doesn't pull in
 * `@aws-sdk/...`/`@google-cloud/...`/`@azure/...` as static deps). The
 * interface defined here is the only thing both sides agree on.
 */

export interface CdnCopyAdapter {
  /**
   * Mark the asset at `assetKey` (object key in primary storage) as
   * CDN-cached. Returns the public CDN URL — admin uses this as the
   * canonical URL for the asset thereafter.
   */
  pin(assetKey: string): Promise<string>;
  /** Reverse — drop from CDN edge cache. */
  unpin(assetKey: string): Promise<void>;
}

/**
 * No-op adapter for self-hosted installs (Caddy serves directly from
 * disk; no separate CDN tier). Returns the input asset key as a relative
 * URL so callers don't have to special-case the no-CDN case.
 */
export const selfHostedCdnCopy: CdnCopyAdapter = {
  async pin(assetKey) {
    return `/media/${assetKey}`;
  },
  async unpin() {
    // no-op
  },
};

/**
 * Resolves the right adapter per `process.env.CAELO_PROVIDER`. Lazy
 * dynamic-imports the per-provider implementation so a self-hosted
 * install never loads the cloud SDKs.
 *
 * Returns `selfHostedCdnCopy` ONLY for `provider==='self-hosted'` or an
 * unset env (treated as self-hosted). For `gcp`/`aws`/`azure`, the
 * matching `cdn-copy-<gcs|aws|azure>.ts` file MUST exist in this
 * directory — those land with the per-provider PRs. Per CLAUDE.md §2
 * "no fallbacks pre-1.0" we deliberately do NOT silently degrade to
 * the self-hosted no-op when the file is missing: a missing module is
 * a deploy bug + the orchestrator tick should crash loudly so the
 * operator notices instead of silently dropping CDN-pin requests.
 */
export async function loadCdnCopyAdapter(provider?: string): Promise<CdnCopyAdapter> {
  switch (provider) {
    case "gcp":
      // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
      return ((await import("./cdn-copy-gcs.js" as string)) as any).gcsCloudCdnPin;
    case "aws":
      // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
      return ((await import("./cdn-copy-aws.js" as string)) as any).s3CloudfrontPrewarm;
    case "azure":
      // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
      return ((await import("./cdn-copy-azure.js" as string)) as any).azureBlobCdnPrefetch;
    case undefined:
    case "":
    case "self-hosted":
      return selfHostedCdnCopy;
    default:
      throw new Error(
        `loadCdnCopyAdapter: unknown CAELO_PROVIDER='${provider}'. Expected one of: self-hosted | gcp | aws | azure.`,
      );
  }
}
