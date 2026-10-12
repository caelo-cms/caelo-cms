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
 * whichever instance built it. The live side is hashed from the fresh
 * build directory, unnormalised. Equal manifests ⇔ the live build is the
 * staging build with only the host replaced.
 *
 * Files that are per-build by design (robots.txt, the deploy and A/B
 * manifests that carry the run id and target) are excluded; every
 * publisher already rewrites them for the destination target.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Build artefacts that legitimately differ between two builds of the same
 * content: robots.txt follows the target's robots policy, and the two
 * manifests carry the target, environment, run id and build time.
 */
export const PER_BUILD_FILES: ReadonlySet<string> = new Set([
  "robots.txt",
  "routing-manifest.json",
  "ab-routing.json",
]);

/** `relative path → content hash`. Paths use `/` and no leading slash. */
export type BuildManifest = Record<string, string>;

/** A pure text transform applied to a staging file before hashing. */
export type ContentNormaliser = (content: string) => string;

function hostOf(origin: string): string {
  return new URL(origin).host;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * The normaliser that turns staging-host content into live-host content:
 * every occurrence of the staging origin becomes the live origin, then
 * every remaining bare staging host (inside JSON-escaped or URL-encoded
 * URLs, `og:url` without a scheme, …) becomes the live host.
 *
 * Content is handled as latin1 so every byte maps to one char and back —
 * binary files pass through unchanged unless they literally contain the
 * host bytes.
 *
 * @example
 *   hostNormaliser("https://staging.example.com", "https://www.example.com")(
 *     '<link rel="canonical" href="https://staging.example.com/a/">')
 *   // → '<link rel="canonical" href="https://www.example.com/a/">'
 */
export function hostNormaliser(stagingUrl: string, liveUrl: string): ContentNormaliser {
  const stagingOrigin = originOf(stagingUrl);
  const liveOrigin = originOf(liveUrl);
  const stagingHost = hostOf(stagingUrl);
  const liveHost = hostOf(liveUrl);
  if (stagingHost === liveHost) {
    throw new Error(
      `the staging host and the live host are both ${liveHost} — staging must have its own host (staging.<domain>) for a host-swapped build to differ from live`,
    );
  }
  return (content) =>
    content.split(stagingOrigin).join(liveOrigin).split(stagingHost).join(liveHost);
}

function contentHash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 32);
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(dir, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(dir, childRel)));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * Hash every file of a build directory, optionally after `normalise`.
 * {@link PER_BUILD_FILES} at the root are left out.
 */
export async function buildManifestOf(
  buildDir: string,
  normalise?: ContentNormaliser,
): Promise<BuildManifest> {
  const manifest: BuildManifest = {};
  for (const rel of (await walk(buildDir)).sort()) {
    if (PER_BUILD_FILES.has(rel)) continue;
    const bytes = await readFile(join(buildDir, rel));
    manifest[rel] = normalise
      ? contentHash(Buffer.from(normalise(bytes.toString("latin1")), "latin1"))
      : contentHash(bytes);
  }
  return manifest;
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
 */
export function parityRefusal(
  diff: ManifestDiff,
  args: { readonly stagingRunId: string; readonly limit?: number },
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
  return (
    `Publish live stopped: the live build differs from staged build ${args.stagingRunId} in more than the host — ${parts.join("; ")}. ` +
    "The site changed after that Stage (another edit was merged, a plugin or setting changed), so live would get something nobody reviewed on staging. " +
    "Next step: Stage again (stage_changes / deploy_staging), check staging, then Publish live."
  );
}
