// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.78 — provider-portable static-publisher adapter.
 *
 * Triggered by deploy.trigger (Stage) and deploy.promote (Confirm
 * publish). One interface, four implementations:
 *
 *   self-hosted → packages/admin-core/src/deploy/static-publisher-self-hosted.ts
 *                 (extracts the existing local-disk + current/ sync logic
 *                 from deploy.ts so behaviour is unchanged for self-hosted
 *                 installs)
 *   gcp         → static-publisher-gcs.ts
 *                 (uploads build dir to a private staging bucket; promote
 *                 = cross-bucket server-side copy to the public static
 *                 bucket)
 *   aws         → static-publisher-aws.ts (stub — throws NotImplemented)
 *   azure       → static-publisher-azure.ts (stub — throws NotImplemented)
 *
 * Mirrors the loadCdnCopyAdapter pattern at
 * packages/provisioning/src/cdn-copy.ts: lazy-loaded per-provider so
 * self-hosted installs don't pull cloud SDKs as static deps.
 *
 * The generator subprocess writes its output to a local buildDir
 * (`<outDir>/builds/<runId>/`) AND syncs into `<outDir>/current/` —
 * publishStaging is the next step that takes the local artifact and
 * makes it reachable as the staged version. For self-hosted that sync
 * is what the generator already did, so publishStaging is effectively
 * a no-op. For cloud providers it uploads the artifact to durable
 * object storage.
 */

import type { DeployTarget } from "@caelo-cms/static-generator";

/**
 * Per-provider summary of a publish step. Persisted into
 * deploy_runs.publish_summary so the Ops dashboard can render a
 * provider-native location string.
 */
export interface PublishSummary {
  provider: "self-hosted" | "gcp" | "aws" | "azure";
  /** How many files were uploaded / synced in this step. May be < the
   *  total file count if the publisher skipped unchanged files via a
   *  hash manifest. */
  uploadedCount: number;
  /** How many files were skipped because their hash matched the live
   *  manifest. 0 for self-hosted (no hash check); cloud publishers
   *  use this to make "skipped 79,000 unchanged of 80,000" visible. */
  skippedUnchangedCount: number;
  /** Provider-native location string for the Ops dashboard.
   *  Examples: 'gs://bucket/_staging/<runId>/' (cloud),
   *  'output/staging/builds/<runId>/' (self-hosted). */
  location: string;
}

export interface PromoteSummary extends PublishSummary {
  /** Build id assigned to the destination's deploy_runs row. */
  destinationBuildId: string;
}

/**
 * One adapter per CAELO_PROVIDER. The deploy ops load the active
 * adapter at handler time (NOT at module load time) so a single
 * admin-core build can be reused across providers without static
 * dependency graphs pulling in @google-cloud/storage on self-hosted.
 */
export interface StaticPublisher {
  /**
   * Publish the build at `buildDir` so the staged version becomes
   * reachable. For self-hosted this is the generator's own
   * `current/` sync; for cloud this uploads to the staging bucket
   * under a per-runId prefix. Idempotent — re-publishing the same
   * runId overwrites.
   */
  publishStaging(args: {
    buildDir: string;
    runId: string;
    target: DeployTarget;
  }): Promise<PublishSummary>;

  /**
   * Promote the staged build into the destination target. For
   * self-hosted this is the existing copyTreeExcept + syncContents
   * sequence into `<dst.outDir>/current/`. For cloud this is a
   * cross-bucket server-side object copy from the private staging
   * bucket to the public static bucket. Per-target overrides
   * (robots.txt, routing-manifest.json) are applied so production's
   * robots reads `index` even when promoting a `noindex` staging
   * artifact.
   */
  promoteToProduction(args: {
    sourceRunId: string;
    sourceBuildDir: string;
    fromTarget: DeployTarget;
    toTarget: DeployTarget;
  }): Promise<PromoteSummary>;

  /**
   * Sync a prior succeeded build's artifact into the destination's
   * live position — the rollback path. Self-hosted re-syncs the
   * archived build dir into `current/`; cloud copies the archived
   * objects (or re-uploads from a build dir if still on disk) into
   * the public static bucket.
   */
  rollback(args: {
    targetBuildId: string;
    sourceBuildDir: string;
    target: DeployTarget;
  }): Promise<PublishSummary>;
}

/**
 * Lazy-load the per-provider implementation. Self-hosted is the
 * default (also the only one bundled in admin-core directly — the
 * cloud impls dynamic-import their cloud SDK so the self-hosted
 * runtime never pays for unused deps).
 *
 * Per CLAUDE.md §2 (no fallbacks pre-1.0): an unrecognised provider
 * name throws loudly rather than silently degrading to self-hosted.
 */
export async function loadStaticPublisher(provider?: string): Promise<StaticPublisher> {
  switch (provider) {
    case "gcp":
      return (await import("./static-publisher-gcs.js")).gcsStaticPublisher;
    case "aws":
      return (await import("./static-publisher-aws.js")).s3StaticPublisher;
    case "azure":
      return (await import("./static-publisher-azure.js")).azureStaticPublisher;
    case undefined:
    case "":
    case "self-hosted":
      return (await import("./static-publisher-self-hosted.js")).selfHostedStaticPublisher;
    default:
      throw new Error(
        `loadStaticPublisher: unknown CAELO_PROVIDER='${provider}'. Expected one of: self-hosted | gcp | aws | azure.`,
      );
  }
}
