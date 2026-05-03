// SPDX-License-Identifier: MPL-2.0

/**
 * P15 — stable-hash A/B variant assignment.
 *
 * MUST produce byte-identical results across all four runtimes:
 *   - self-hosted (P13 Caddy gateway)
 *   - GCP edge router (Cloud Run header rule)
 *   - AWS edge router (Lambda@Edge)
 *   - Azure edge router (Front Door rules engine)
 *
 * Drift between runtimes means a visitor sees different variants
 * depending on which provider serves them — silent A/B contamination.
 * The byte-identity test in `index.test.ts` asserts a fixed corpus of
 * (visitorId, manifestVersion, experimentId) tuples maps to the same
 * variant label on every implementation.
 *
 * Algorithm: FNV-1a 32-bit hash of (visitorId + ":" + experimentId +
 * ":" + manifestVersion). The 32-bit space mod 100 gives a bucket in
 * [0, 99]; cumulative variant weights determine the variant. Pure +
 * deterministic; no randomness, no time, no provider-specific code.
 */

import type { ManifestExperiment, ManifestVariant } from "./manifest.js";

/**
 * FNV-1a 32-bit. Standard offset basis 0x811c9dc5, prime 0x01000193.
 * Implemented in plain TypeScript so every runtime (V8 / SpiderMonkey
 * / Node L@E sandbox / Bun) produces byte-identical output.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime, keeping in 32-bit unsigned range. Math.imul
    // is the cross-runtime way to do 32-bit-truncated integer multiply.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce back to unsigned 32-bit.
  return hash >>> 0;
}

/**
 * Compute the cumulative bucket boundaries for an experiment's variants.
 * Stable: same input order → same boundaries → same assignment.
 */
function bucketBoundaries(variants: ReadonlyArray<ManifestVariant>): number[] {
  let cum = 0;
  return variants.map((v) => {
    cum += v.weight;
    return cum;
  });
}

/**
 * Assign a variant to a visitor for one experiment. Inputs:
 *   - visitorId: stable opaque string from the `caelo_visitor_id` cookie.
 *   - manifestVersion: bumped per deploy so a re-bucketing rolls out
 *     atomically (operators occasionally need to re-randomize after a
 *     biased early sample).
 *   - experiment: the matched ManifestExperiment.
 *
 * Returns the chosen variant + its rewrite path. Pure; no I/O.
 */
export function assignVariant(opts: {
  readonly visitorId: string;
  readonly manifestVersion: string;
  readonly experiment: ManifestExperiment;
}): ManifestVariant {
  const key = `${opts.visitorId}:${opts.experiment.experimentId}:${opts.manifestVersion}`;
  const hash = fnv1a32(key);
  const bucket = hash % 100;
  const boundaries = bucketBoundaries(opts.experiment.variants);
  for (let i = 0; i < boundaries.length; i += 1) {
    if (bucket < (boundaries[i] ?? 0)) {
      const v = opts.experiment.variants[i];
      if (v) return v;
    }
  }
  // Fallthrough (weights summed to 100 but float drift) — return last.
  // Schema-level validation guarantees this doesn't happen in practice.
  return opts.experiment.variants[opts.experiment.variants.length - 1] as ManifestVariant;
}

/**
 * Format the assignment-log entry every runtime emits. Same JSON shape
 * across providers so the P12A analytics plugin's per-provider log
 * adapters can normalise into one `ab_assignment_aggregates` query.
 */
export interface AssignmentLogEntry {
  readonly kind: "ab_assignment";
  readonly experimentId: string;
  readonly variantLabel: string;
  readonly visitorId: string;
  readonly manifestVersion: string;
  readonly tsMs: number;
}

export function buildAssignmentLog(opts: {
  readonly experimentId: string;
  readonly variant: ManifestVariant;
  readonly visitorId: string;
  readonly manifestVersion: string;
  readonly nowMs?: number;
}): AssignmentLogEntry {
  return {
    kind: "ab_assignment",
    experimentId: opts.experimentId,
    variantLabel: opts.variant.label,
    visitorId: opts.visitorId,
    manifestVersion: opts.manifestVersion,
    tsMs: opts.nowMs ?? Date.now(),
  };
}

/**
 * Mint a stable opaque visitor id when the request didn't carry the
 * `caelo_visitor_id` cookie. Format: 16 hex bytes (128 bits — collision
 * resistant for any plausible visitor population). Edge routers set
 * this on the response cookie so the next request inherits the same id.
 */
export function mintVisitorId(): string {
  const buf = new Uint8Array(16);
  // crypto.getRandomValues is available in V8 / Node / L@E / Bun /
  // every modern runtime; no Node Buffer fallback needed.
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
