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

import type { PhaseTiming, RedirectTableRow } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import type { UnservedRedirectTarget } from "./redirect-sync-plan.js";

/**
 * Per-provider summary of a publish step. Persisted into
 * deploy_runs.publish_summary so the Ops dashboard can render a
 * provider-native location string.
 */
export interface PublishSummary {
  provider: "self-hosted" | "gcp" | "gcp-firebase" | "aws" | "azure";
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
  /**
   * v0.3.0 — provider-supplied origin of the staged build. Populated by
   * the Firebase Hosting publisher (the preview channel URL, like
   * https://<site>--runid-<runId>-<hash>.web.app). #650 — internal only:
   * the quality audit loads it directly and the gateway proxies
   * staging.<domain> to it; operators and the AI are shown the staging
   * host instead. Absent on other publishers.
   */
  previewUrl?: string;
  /**
   * Where the publish spent its time, step by step (hashing, upload,
   * channel …). The Stage records them with its own steps in
   * deploy_runs.phase_timings and leaves them out of publish_summary.
   */
  phases?: readonly PhaseTiming[];
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
   * True when this provider's serving layer reads `<outDir>/current/`
   * (self-hosted Caddy bind-mounts it): the generator then mirrors every
   * build into it. Cloud publishers upload the build directory itself and
   * nothing reads `current/`, so the mirror is skipped (#1003 — it was the
   * largest step of a Stage, and on Cloud Run `/tmp` is memory).
   */
  readonly servesCurrentDir: boolean;

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
   * robots reads `index` — with the `Sitemap:` line when the build
   * carries a sitemap.xml — even when promoting a `noindex` staging
   * artifact. Env-level response headers (staging's
   * `X-Robots-Tag: noindex`) follow the DESTINATION target, never the
   * source. The page HTML and sitemap.xml ship verbatim: the generator
   * renders them env-independently (apps/static-generator/src/seo-pass.ts).
   * A source build whose manifest says its pages carry the source
   * env's noindex is refused (`manifestBakesEnvNoindex`).
   */
  promoteToProduction(args: {
    sourceRunId: string;
    sourceBuildDir: string;
    fromTarget: DeployTarget;
    toTarget: DeployTarget;
    /** site_defaults.site_base_url — the absolute base of the
     *  destination robots.txt `Sitemap:` line. */
    siteBaseUrl: string;
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
    /** site_defaults.site_base_url — publishers that re-derive the
     *  target's robots.txt on rollback (Firebase) need it for the
     *  `Sitemap:` line. */
    siteBaseUrl: string;
    /** The rolled-back run's `publish_summary.location` — where that run's
     *  artefact lives on publishers that keep it remotely (Firebase: the
     *  Hosting version). Null when the run recorded none. */
    sourceLocation: string | null;
  }): Promise<PublishSummary>;

  /**
   * #650 — put a freshly built tree live as it is (Publish live on a
   * provider whose staging has its own host: the live build is a rebuild
   * of the staged content with the live host, checked by the parity guard
   * first). Implemented by the publishers of providers with a staging
   * domain (deploy/staging-domain.ts); absent elsewhere.
   */
  publishLiveBuild?(args: {
    buildDir: string;
    runId: string;
    target: DeployTarget;
    /** The staged run the build was checked against. */
    sourceRunId: string;
  }): Promise<PromoteSummary>;

  /**
   * #1157 — put the redirects table live on `target` WITHOUT a build: compute
   * the redirect plan against the files of the build the target serves now
   * (the live page wins) and write it where this provider answers redirects
   * (Firebase: a new Hosting release of the served version with the new
   * `config.redirects`; GCP: the URL map's redirect rules; self-hosted: the
   * `_redirects.caddy` snippet Caddy reloads). A plan the provider already
   * answers is not written again (`unchanged`). A target this provider serves
   * no redirects for answers `not-served`. Throws when the plan cannot be
   * built (a loop) or written — the caller records the failure and retries.
   */
  syncRedirects(args: RedirectSyncArgs): Promise<RedirectSyncResult>;

  /**
   * #650 / #908 / #969 — make `servedRunId`'s public preview the one staging
   * serves, and retire every other one. A preview is created with a short
   * TTL, so a Stage that fails before it is selected leaves nothing that
   * outlives it; selection extends the served preview's lifetime as far as
   * the provider allows (Firebase: a 30-day TTL — a preview channel cannot
   * be made permanent), and {@link refreshStagingPreview} keeps extending it
   * so an idle staging does not expire into 404s; a retired preview gets the
   * short TTL back before it is deleted, so one whose delete fails still
   * expires soon. `servedRunId: null` retires them all.
   *
   * Throws when the served preview cannot be kept alive (including when it
   * no longer exists) — the caller must not record it as served. Previews
   * that could not be retired are reported in `notRetired`, not thrown:
   * the next selection retries them. Absent on publishers whose staging is
   * not publicly reachable per run.
   */
  selectStagingPreview?(args: { servedRunId: string | null }): Promise<StagingPreviewSelection>;

  /**
   * #969 — extend the served preview's lifetime again without touching any
   * other preview: the periodic keep-alive between Stages. Throws when the
   * preview no longer exists (Stage again) or the provider did not extend
   * it. Present exactly on publishers that implement selectStagingPreview
   * with a finite served lifetime.
   */
  refreshStagingPreview?(args: { servedRunId: string }): Promise<StagingPreviewRefresh>;
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
    case "gcp-firebase":
      return (await import("./static-publisher-firebase.js")).firebaseHostingPublisher;
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
        `loadStaticPublisher: unknown CAELO_PROVIDER='${provider}'. Expected one of: self-hosted | gcp | gcp-firebase | aws | azure.`,
      );
  }
}

/** Input of {@link StaticPublisher.syncRedirects}. */
export interface RedirectSyncArgs {
  readonly target: DeployTarget;
  /** Every row of the redirects table. */
  readonly rows: readonly RedirectTableRow[];
  /** The deploy run whose build the target serves (staging: the served preview's run). */
  readonly servedRunId: string;
  /** The directory relative `target.outDir` values resolve against (self-hosted). */
  readonly outputRoot: string;
}

/** What {@link StaticPublisher.syncRedirects} did. */
export interface RedirectSyncResult {
  /**
   * `applied`: the provider now answers the plan; `unchanged`: it already
   * did; `not-served`: this provider serves no redirects on this target.
   */
  readonly outcome: "applied" | "unchanged" | "not-served";
  readonly redirectCount: number;
  readonly goneCount: number;
  /** Rows left out because a file of the served build answers their path. */
  readonly shadowedCount: number;
  /** Redirects whose target the served build does not have (draft pages, until Publish live). */
  readonly unservedTargets: readonly UnservedRedirectTarget[];
  /** Provider-native location of what serves the plan (Hosting version, URL map, file). */
  readonly location: string;
  /**
   * Set when the sync moved the served build itself to a new location (a
   * new Firebase Hosting version with the same files): the deploy run whose
   * `publish_summary.location` is `from` moves to `to`, so a rollback to
   * that run still finds its build after older versions age out.
   */
  readonly movedServedBuild?: { readonly from: string; readonly to: string };
}

/** What {@link StaticPublisher.selectStagingPreview} did with the other previews. */
export interface StagingPreviewSelection {
  /** Previews deleted (or already gone). */
  readonly retired: readonly string[];
  /** Previews that are still there, each with why its retirement failed. */
  readonly notRetired: readonly { readonly preview: string; readonly error: string }[];
  /** When the served preview now expires (ISO 8601); null when nothing is served. */
  readonly servedExpiresAt: string | null;
}

/** What {@link StaticPublisher.refreshStagingPreview} did. */
export interface StagingPreviewRefresh {
  /** When the served preview now expires (ISO 8601). */
  readonly expiresAt: string;
}
