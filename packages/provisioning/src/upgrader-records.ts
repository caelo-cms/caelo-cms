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
 * A serving image is a release's image when its digest is one of that
 * image's forms (#1025, upgrade/image-forms.ts): the index the manifest
 * signs, or a platform manifest inside it. Cloud Run records the
 * linux/amd64 platform manifest it resolved, so comparing with the index
 * alone never matched on a live install.
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
import type { ReleaseImageForms } from "./upgrade/image-forms.js";
import { releaseVersionForDigest } from "./upgrade/release-images.js";

/** Every digest each serving image is known by (gcp-lookup.ts servingImageDigests). */
export type ServingDigests = Readonly<Record<RollSlug, readonly string[]>>;

const SLUGS: readonly RollSlug[] = ["admin", "gateway"];

/**
 * Whether install.json names the images that serve: per service, the
 * recorded index digest or its recorded linux/amd64 form (#1025) is one of
 * the digests the serving revision is known by.
 */
export function recordMatchesServing(
  recorded: Pick<InstallMetadata, "imageDigests" | "platformDigests">,
  serving: ServingDigests,
): boolean {
  const { imageDigests, platformDigests } = recorded;
  if (!imageDigests) return false;
  return SLUGS.every(
    (slug) =>
      serving[slug].includes(imageDigests[slug]) ||
      (platformDigests !== undefined && serving[slug].includes(platformDigests[slug])),
  );
}

/** What {@link findServingRelease} learned. */
export type ServingRelease =
  | {
      readonly ok: true;
      readonly manifest: ReleaseManifest;
      /**
       * The linux/amd64 form of each of its images (#1025), to record next
       * to the index digests; null when it is not known for both.
       */
      readonly platformDigests: ImageDigests | null;
    }
  | {
      readonly ok: false;
      /**
       * True when no release matched but a candidate's manifest could not be
       * fetched because the registry was unreachable or failing (5xx, 429,
       * network): an outage, not a verdict, so the run must end `failed` and
       * be retried, not send the operator to Cloud Shell. A manifest the
       * registry says does not exist (404) never appears on retry, so it
       * counts as rejected like a bad signature.
       */
      readonly retryable: boolean;
      readonly reason: string;
    };

export interface ServingReleaseDeps {
  readonly run: GcloudRunner;
  /** fetchVerifiedReleaseManifest against the fixed registry. */
  readonly fetchManifest: (version: string) => Promise<ReleaseManifestResult>;
  /** Every digest a release image is known by (#1025; createReleaseImageForms). */
  readonly imageForms: ReleaseImageForms;
  /**
   * The image digests the services' templates name (the index a deploy
   * pinned; after a rollback, possibly another release's). Untrusted hints
   * for which release tags to look up, asked only when nothing else found
   * the serving release.
   */
  readonly hintDigests?: () => Promise<ServingDigests>;
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
  const unreachable: string[] = [];
  const tried: string[] = [];
  for await (const version of candidateVersions(meta, serving, deps)) {
    if (tried.includes(version)) continue;
    tried.push(version);
    const fetched = await deps.fetchManifest(version);
    if (!fetched.ok) {
      if (fetched.error.code === "registry" && fetched.error.transient) {
        unreachable.push(`v${version} (${fetched.error.message.slice(0, 200)})`);
        continue;
      }
      unverified.push(`v${version} (${fetched.error.message.slice(0, 200)})`);
      continue;
    }
    const m = fetched.manifest;
    const judged = await judgeRelease(m, serving, deps.imageForms);
    if (judged.kind === "unreadable") {
      // The index could not be read, so this release is neither confirmed
      // nor ruled out: an outage is retried, anything else is a release
      // record that could not be verified.
      (judged.transient ? unreachable : unverified).push(`v${version} (${judged.message})`);
      continue;
    }
    if (judged.matching.length === SLUGS.length) {
      return { ok: true, manifest: m, platformDigests: judged.platformDigests };
    }
    if (judged.matching.length > 0) {
      const other = SLUGS.filter((s) => !judged.matching.includes(s));
      partial.push(
        `the ${judged.matching.join(", ")} serves v${m.version}'s image, the ${other.join(", ")} does not`,
      );
    }
  }
  const servingText = SLUGS.map((s) => `${s} ${serving[s][0] ?? "(unknown)"}`).join(", ");
  if (unreachable.length > 0) {
    // A release we could not read may be the serving one, so this is no
    // verdict on the images: retry later rather than escalate.
    return {
      ok: false,
      retryable: true,
      reason: `Nothing was changed: the images that serve now (${servingText}) are not the ones install.json names, and the Caelo release registry could not be reached to check which release they belong to (${unreachable.join("; ")}). Try again later.`,
    };
  }
  return {
    ok: false,
    retryable: false,
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

/** Which of release `m`'s images serve, by {@link judgeRelease}. */
type ReleaseJudgement =
  | {
      readonly kind: "judged";
      readonly matching: readonly RollSlug[];
      readonly platformDigests: ImageDigests | null;
    }
  | { readonly kind: "unreadable"; readonly transient: boolean; readonly message: string };

/**
 * Which of `m`'s images serve. A serving digest equal to the signed index
 * matches without a lookup; any other is compared with the image's
 * platform forms (signed, or read from the content-checked index).
 */
async function judgeRelease(
  m: ReleaseManifest,
  serving: ServingDigests,
  imageForms: ReleaseImageForms,
): Promise<ReleaseJudgement> {
  const matching: RollSlug[] = [];
  const platform: Partial<Record<RollSlug, string>> = {};
  for (const slug of SLUGS) {
    if (serving[slug].includes(m.digests[slug])) {
      matching.push(slug);
      const signed = m.platformDigests?.[slug];
      if (signed) platform[slug] = signed;
      continue;
    }
    const forms = await imageForms.of(m, slug);
    if (!forms.ok)
      return { kind: "unreadable", transient: forms.transient, message: forms.message };
    const match = serving[slug].find((d) => forms.digests.includes(d));
    if (match) {
      matching.push(slug);
      if (forms.amd64) platform[slug] = forms.amd64;
    }
  }
  const { admin, gateway } = platform;
  return {
    kind: "judged",
    matching,
    platformDigests: admin && gateway ? { admin, gateway } : null,
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
  deps: ServingReleaseDeps,
): AsyncGenerator<string> {
  if (meta.releaseVersion) yield meta.releaseVersion;
  // Release tags point at the index digest a deploy pins. The platform
  // digest Cloud Run records for a revision (#1025) has no tag, so the
  // indexes the service templates name are asked too: only hints, the
  // signed manifest still decides.
  const asked: string[] = [];
  const tagged = async function* (digests: ServingDigests): AsyncGenerator<string> {
    for (const slug of SLUGS) {
      for (const digest of digests[slug]) {
        if (asked.includes(`${slug}@${digest}`)) continue;
        asked.push(`${slug}@${digest}`);
        const version = await releaseVersionForDigest(deps.run, slug, digest);
        if (version) yield version;
      }
    }
  };
  yield* tagged(serving);
  if (deps.hintDigests) yield* tagged(await deps.hintDigests());
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
