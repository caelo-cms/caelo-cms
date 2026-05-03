// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — A/B routing manifest. Static-generator emits this file at deploy
 * time (P6 + P13 contract). Per-provider edge routers (Cloud CDN /
 * CloudFront L@E / Front Door rules / self-hosted Caddy gateway) all
 * read this single shape so behaviour is identical across runtimes.
 *
 * Variant URL paths follow the convention:
 *   control:  /<page-slug>
 *   variant:  /_caelo-variant/<experimentId>/<variantLabel>/<page-slug>
 *
 * (Picked path-based over query-string-based so CDN cache keys aren't
 * affected by query-string normalisation. See plans/phases/phase_15.)
 */

export interface ManifestVariant {
  /** Owner-readable label (e.g. "A", "B", "control"). Stable across deploys. */
  readonly label: string;
  /** Bucket weight in [0, 100]. All variants for one experiment must sum to 100. */
  readonly weight: number;
  /**
   * Path the edge router rewrites to when this variant wins. Includes
   * the /_caelo-variant prefix for non-control variants; equal to
   * `pageSlug` for control.
   */
  readonly path: string;
}

export interface ManifestExperiment {
  /** Page slug the experiment runs on (e.g. "/home", "/pricing"). */
  readonly pageSlug: string;
  /** UUID — also the cookie partition key so two experiments don't collide. */
  readonly experimentId: string;
  readonly variants: ReadonlyArray<ManifestVariant>;
}

export interface RoutingManifest {
  /** Bumped by the static generator on every deploy that changes routing. */
  readonly manifestVersion: string;
  /** All active experiments (only `status='active'` rows from cms_admin.experiments). */
  readonly experiments: ReadonlyArray<ManifestExperiment>;
}

export const EMPTY_MANIFEST: RoutingManifest = {
  manifestVersion: "0",
  experiments: [],
};

/**
 * Look up the active experiment for a given request URL. Returns null
 * when no experiment matches the URL's page slug — caller should pass
 * the request through unchanged.
 */
export function findExperimentForUrl(
  manifest: RoutingManifest,
  pathname: string,
): ManifestExperiment | null {
  for (const ex of manifest.experiments) {
    if (ex.pageSlug === pathname) return ex;
  }
  return null;
}

/**
 * Validates a manifest's invariants: every experiment's variant weights
 * sum to 100, every variant has a non-empty label, the experimentId is
 * a UUID, weights are non-negative. Returns null on success or a
 * structured error string the static generator surfaces in audit. The
 * runtime callers (edge routers) do NOT re-validate per request — they
 * trust the deploy-time validation. This function is primarily for
 * tests + the deploy step.
 */
export function validateManifest(manifest: RoutingManifest): string | null {
  for (const ex of manifest.experiments) {
    if (!ex.experimentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return `experiment ${ex.experimentId} is not a UUID`;
    }
    if (ex.variants.length === 0) {
      return `experiment ${ex.experimentId} has no variants`;
    }
    let total = 0;
    for (const v of ex.variants) {
      if (!v.label) return `experiment ${ex.experimentId}: variant has empty label`;
      if (v.weight < 0)
        return `experiment ${ex.experimentId}: variant ${v.label} has negative weight`;
      total += v.weight;
    }
    if (total !== 100) {
      return `experiment ${ex.experimentId}: variant weights sum to ${total}, expected 100`;
    }
  }
  return null;
}
