// SPDX-License-Identifier: MPL-2.0

/**
 * `--version` on a gcp / gcp-firebase install (#1558): which release a
 * wizard run installs when the operator names one, and what the install
 * job's launcher records for it.
 *
 * Without `--version` a new install resolves the registry's `latest` tag
 * (local mode) or the CLI's own release (job mode). With it, the named
 * release, so a release candidate can be scratch-installed before any
 * install is offered it. The installer still never changes the version of
 * an install that runs: that is `upgrade`'s job, which migrates the
 * database before it shifts traffic. Nothing is migrated before the first
 * `pulumi up` succeeded (wizards/gcp.ts), so until then a recorded release
 * may still be replaced.
 */

import { provisioningCommand } from "@caelo-cms/shared";
import type { ImageDigests } from "./install-state.js";
import { manifestServiceImages, type ReleaseManifest } from "./release-manifest.js";
import { canonicalReleaseTag } from "./upgrade/release-images.js";

/** What `--version` means for one wizard run. */
export type InstallVersionDecision =
  /** No `--version`: the wizard's usual choice (wizards/gcp.ts chooseImageDigests). */
  | { readonly kind: "none" }
  /** The install already runs this release; the run converges, nothing else. */
  | { readonly kind: "keep"; readonly version: string }
  /** Resolve, verify and record this release before anything is created. */
  | { readonly kind: "install"; readonly version: string }
  | { readonly kind: "refuse"; readonly error: string };

/**
 * Decide what `--version` does for an install.
 *
 * @param input.deployed - whether the install's first `pulumi up` succeeded
 *   (from then on its database may be migrated by the release it runs).
 * @param input.recordedVersion - install.json's `releaseVersion`.
 */
export function decideInstallVersion(input: {
  readonly requested: string | undefined;
  readonly deployed: boolean;
  readonly recordedVersion: string | undefined;
}): InstallVersionDecision {
  if (input.requested === undefined) return { kind: "none" };
  const tag = canonicalReleaseTag(input.requested);
  if (!tag) {
    return {
      kind: "refuse",
      error: `--version ${JSON.stringify(input.requested)} is not a release version. Name one like 0.12.4 or 0.12.5-rc.1 (https://github.com/caelo-cms/caelo-cms/releases).`,
    };
  }
  const version = tag.replace(/^v/, "");
  if (!input.deployed) return { kind: "install", version };
  if (input.recordedVersion === version) return { kind: "keep", version };
  const runs = input.recordedVersion ? `v${input.recordedVersion}` : "a release";
  return {
    kind: "refuse",
    error: `This install already runs ${runs}. Re-running the installer converges its cloud setup and never changes the release; to move it to v${version}, run: ${provisioningCommand(version, ["upgrade", "--version", version])}`,
  };
}

/**
 * The release a job-mode install records before its job starts, from the
 * release's signed manifest: the three images the stack deploys and the
 * version. Every image the stack runs must be named, or the job's release
 * choice refuses the record (deployed-release.ts chooseImageDigests).
 */
export function installRecordFromManifest(
  manifest: Pick<ReleaseManifest, "version" | "digests">,
):
  | { readonly ok: true; readonly digests: ImageDigests; readonly version: string }
  | { readonly ok: false; readonly error: string } {
  const images = manifestServiceImages(manifest);
  if (!images.ok) return images;
  return {
    ok: true,
    digests: {
      admin: images.images.admin.digest,
      gateway: images.images.gateway.digest,
      "mcp-auth-proxy": images.images["mcp-auth-proxy"].digest,
    },
    version: manifest.version,
  };
}

/**
 * Whether the launcher records the release it verified. Never once the
 * install's first `pulumi up` succeeded; before that when the operator named
 * a version, when nothing is recorded yet, or when the record lacks the
 * MCP-Auth-Proxy (written by a launcher from before it recorded one).
 */
export function launcherRecordsRelease(input: {
  readonly deployed: boolean;
  readonly requested: boolean;
  readonly recorded: ImageDigests | null;
}): boolean {
  if (input.deployed) return false;
  return input.requested || input.recorded === null || !input.recorded["mcp-auth-proxy"];
}
