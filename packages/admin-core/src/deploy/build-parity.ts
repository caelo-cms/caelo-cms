// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the staging ↔ live parity guard.
 *
 * Where staging has its own host (`staging.<domain>`), a staging build is
 * rendered with that host in every canonical, sitemap entry, og:url,
 * hreflang and absolute link, so Publish live can no longer copy it: it
 * rebuilds the same content with the live host. What goes live must still
 * be exactly what was reviewed on staging, so before publishing the two
 * builds are compared file by file with the host swapped back — any other
 * difference (a file added or removed, content that changed because main
 * moved on since the Stage) blocks the publish.
 *
 * The staging side is recorded at Stage time as a manifest of
 * host-normalised content hashes (`deploy_runs.parity_manifest`), because
 * the staging build directory is ephemeral on Cloud Run and lives on
 * whichever instance built it. The live side is the fresh build's,
 * unnormalised. Equal manifests ⇔ the live build is the staging build
 * with only the host replaced. #1271 — both are taken by the generator as
 * it writes each file, so no file is read again to fingerprint a build.
 *
 * Files that are per-build by design (robots.txt and the deploy manifest,
 * which carry the target and run id) are excluded; every publisher already
 * rewrites them for the destination target. Everything else is compared
 * byte for byte (after the host swap): a build output that differs between
 * two builds of the same content must be made deterministic, never
 * special-cased here.
 */

import { PARITY_REFUSAL_PREFIX, RESTAGE_NEXT_STEP } from "@caelo-cms/shared";
import { type BuildManifest, readBuildParity } from "@caelo-cms/static-generator";

// #1271 — the digests are taken by the generator while it writes each file
// (static-generator parity-digest.ts); these are re-exported for the ops.
export { type BuildManifest, hostNormaliser } from "@caelo-cms/static-generator";

/**
 * The parity manifest of a finished build, as its generator recorded it:
 * `plain` (the bytes as written — a live rebuild), or `normalised` (staging
 * host swapped back to the live one — what a Stage with its own staging
 * host records for Publish live). The per-build files (robots.txt, the
 * routing manifest) are left out;
 * referenced media and fonts are in it by their stored content hash.
 * Throws when the build has no normalised manifest but one is asked for
 * (it was not rendered with a staging host).
 */
export async function buildManifestOf(
  buildDir: string,
  which: "plain" | "normalised",
): Promise<BuildManifest> {
  const parity = await readBuildParity(buildDir);
  if (which === "plain") return parity.plain;
  if (parity.normalised === null) {
    throw new Error(
      `build ${buildDir} was not rendered with a staging host, so it has no host-normalised parity manifest`,
    );
  }
  return parity.normalised;
}

/** How two build manifests differ. Every list is sorted. */
export interface ManifestDiff {
  /** In the live build, not in the staged one. */
  readonly added: readonly string[];
  /** In the staged build, not in the live one. */
  readonly removed: readonly string[];
  /** In both, with different content after the host swap. */
  readonly changed: readonly string[];
}

/** Compare a staged manifest (host-normalised) with a live one. */
export function compareBuildManifests(staged: BuildManifest, live: BuildManifest): ManifestDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(live)) {
    const before = staged[path];
    if (before === undefined) added.push(path);
    else if (before !== hash) changed.push(path);
  }
  for (const path of Object.keys(staged)) if (!(path in live)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** True when the diff is empty. */
export function manifestsMatch(diff: ManifestDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * The operator/AI-facing refusal for a non-empty diff, naming the first
 * differing files of each kind and the next step; null when they match.
 *
 * #834 — the cause is named from the Caelo versions: when the staged build
 * was rendered by another Caelo version than the one rebuilding it now,
 * the upgrade is the cause and is said first (the new generator renders
 * the same content differently). When the staged build predates version
 * recording (`stagedCaeloVersion` null), the message says the version is
 * unknown instead of guessing either cause.
 *
 * @param args.stagedCaeloVersion `deploy_runs.caelo_version` of the
 *   staged run; null when it was staged before Caelo recorded it.
 * @param args.runningCaeloVersion the version rebuilding for live
 *   (`CAELO_VERSION`).
 */
export function parityRefusal(
  diff: ManifestDiff,
  args: {
    readonly stagingRunId: string;
    readonly stagedCaeloVersion: string | null;
    readonly runningCaeloVersion: string;
    readonly limit?: number;
  },
): string | null {
  if (manifestsMatch(diff)) return null;
  const limit = args.limit ?? 10;
  const list = (label: string, paths: readonly string[]) =>
    paths.length === 0
      ? null
      : `${paths.length} ${label} (${paths.slice(0, limit).join(", ")}${paths.length > limit ? ", …" : ""})`;
  const parts = [
    list("changed", diff.changed),
    list("only in the live build", diff.added),
    list("missing from the live build", diff.removed),
  ].filter((p): p is string => p !== null);
  const differs = `the live build differs from staged build ${args.stagingRunId} in more than the host — ${parts.join("; ")}.`;
  const unreviewed = "Live would get something nobody reviewed on staging.";
  const { stagedCaeloVersion: staged, runningCaeloVersion: running } = args;
  if (staged !== null && staged !== running) {
    return (
      `${PARITY_REFUSAL_PREFIX} Caelo was updated from ${staged} to ${running} since this Stage, and the new version renders the site differently — ${differs} ` +
      `${unreviewed} ${RESTAGE_NEXT_STEP}`
    );
  }
  if (staged === null) {
    return (
      `${PARITY_REFUSAL_PREFIX} ${differs} ` +
      `The Caelo version that made this Stage is unknown (it was staged before Caelo recorded versions), so the cause is either a Caelo update to ${running} since then or a site change after that Stage (another edit was merged, a plugin or setting changed). ` +
      `${unreviewed} ${RESTAGE_NEXT_STEP}`
    );
  }
  return (
    `${PARITY_REFUSAL_PREFIX} ${differs} ` +
    "The site changed after that Stage (another edit was merged, a plugin or setting changed). " +
    `${unreviewed} ${RESTAGE_NEXT_STEP}`
  );
}
