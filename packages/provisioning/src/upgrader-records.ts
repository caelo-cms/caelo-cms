// SPDX-License-Identifier: MPL-2.0

/**
 * Does install.json describe what serves, and if not, which signed release
 * does (#860)?
 *
 * The upgrader judges a request (downgrade, minFromVersion, infra contract)
 * against the version install.json records, so it must first know the
 * record is true. When the recorded digests differ from the serving ones,
 * the only repair a human could make is "record the release that serves",
 * and the job can do that itself without widening its trust: it records a
 * release only when BOTH serving images (admin + gateway) are the images of
 * one release manifest that verified against Caelo's release workflow
 * (fetchVerifiedReleaseManifest, the same cosign check every install takes).
 * Images that belong to no signed release are a deployment nobody can
 * vouch for, so the run stops and says so.
 *
 * Which releases to try comes from untrusted hints — the version
 * install.json names, and the release tags pointing at the serving digests
 * in the fixed mirror (releaseVersionForDigest). A wrong hint costs one
 * manifest fetch; only the signed manifest decides.
 */

import type { GcloudRunner } from "./gcloud-retry.js";
import type { ImageDigests, InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import type { RollSlug } from "./upgrade/app-roll.js";
import { releaseVersionForDigest } from "./upgrade/release-images.js";

/** Every digest each serving image is known by (gcp-lookup.ts servingImageDigests). */
export type ServingDigests = Readonly<Record<RollSlug, readonly string[]>>;

const SLUGS: readonly RollSlug[] = ["admin", "gateway"];

/** Whether `recorded` names the images that serve, in any form they are known by. */
export function recordMatchesServing(
  recorded: ImageDigests | undefined,
  serving: ServingDigests,
): boolean {
  if (!recorded) return false;
  return SLUGS.every((slug) => serving[slug].includes(recorded[slug]));
}

/** What {@link findServingRelease} learned. */
export type ServingRelease =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | { readonly ok: false; readonly reason: string };

export interface ServingReleaseDeps {
  readonly run: GcloudRunner;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
}

/**
 * The signed release whose admin AND gateway images both serve, or why there
 * is none (an operator-facing sentence naming the serving digests).
 *
 * @param meta - install.json as read; its `releaseVersion` is the first hint.
 */
export async function findServingRelease(
  meta: InstallMetadata,
  serving: ServingDigests,
  deps: ServingReleaseDeps,
): Promise<ServingRelease> {
  const partial: string[] = [];
  const unverified: string[] = [];
  const tried: string[] = [];
  for await (const version of candidateVersions(meta, serving, deps.run)) {
    if (tried.includes(version)) continue;
    tried.push(version);
    const fetched = await deps.fetchManifest(version);
    if (!fetched.ok) {
      unverified.push(`v${version} (${fetched.error.message.slice(0, 200)})`);
      continue;
    }
    const m = fetched.manifest;
    const matching = SLUGS.filter((slug) => serving[slug].includes(m.digests[slug]));
    if (matching.length === SLUGS.length) return { ok: true, manifest: m };
    if (matching.length > 0) {
      const other = SLUGS.filter((s) => !matching.includes(s));
      partial.push(
        `the ${matching.join(", ")} serves v${m.version}'s image, the ${other.join(", ")} does not`,
      );
    }
  }
  const servingText = SLUGS.map((s) => `${s} ${serving[s][0] ?? "(unknown)"}`).join(", ");
  return {
    ok: false,
    reason: [
      `The images that serve now (${servingText}) are not the ones install.json names, and they do not belong to one signed Caelo release${tried.length === 0 ? " (no release tag could be found for them)" : ""}, so the upgrader cannot tell what this install runs.`,
      ...(partial.length > 0 ? [`${capitalize(partial.join("; "))}.`] : []),
      ...(unverified.length > 0
        ? [`These release records could not be verified: ${unverified.join("; ")}.`]
        : []),
      "Nothing was changed. Check who deployed these images (the Cloud Run revision history of both services); an upgrade with Cloud Shell puts a signed release back.",
    ].join(" "),
  };
}

/**
 * Release versions worth checking, most likely first. Lazy: the version
 * install.json names usually is the serving one, and then no tag listing
 * runs at all.
 */
async function* candidateVersions(
  meta: InstallMetadata,
  serving: ServingDigests,
  run: GcloudRunner,
): AsyncGenerator<string> {
  if (meta.releaseVersion) yield meta.releaseVersion;
  // Release tags point at the index digest a deploy pins (the deployed form,
  // listed first); the platform digest Cloud Run resolved has no tag.
  for (const slug of SLUGS) {
    for (const digest of serving[slug]) {
      const version = await releaseVersionForDigest(run, slug, digest);
      if (version) yield version;
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
