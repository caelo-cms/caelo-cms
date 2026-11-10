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
import {
  forgetCachedState,
  type ImageDigests,
  isStepDone,
  readMetadata,
  recordedImageDigests,
  recordImageDigests,
} from "./install-state.js";
import { compareSemver, manifestServiceImages, type ReleaseManifest } from "./release-manifest.js";
import { canonicalReleaseTag } from "./upgrade/release-images.js";

/**
 * The oldest release `--version` installs: the first with its own
 * MCP-Auth-Proxy image (#1328). This installer deploys the proxy next to the
 * admin and the gateway, so it has nothing to deploy for an older release,
 * and the release choice refuses a record without one
 * (deployed-release.ts chooseImageDigests).
 */
export const OLDEST_INSTALLABLE_RELEASE = "0.11.10";

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
  if (input.deployed && input.recordedVersion === version) return { kind: "keep", version };
  if (compareSemver(version, OLDEST_INSTALLABLE_RELEASE) < 0) {
    return {
      kind: "refuse",
      error: `v${version} predates the MCP-Auth-Proxy (#1328), which this installer deploys next to the admin and the gateway: --version installs v${OLDEST_INSTALLABLE_RELEASE} or later.`,
    };
  }
  if (!input.deployed) return { kind: "install", version };
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

/**
 * Record the release the install job about to start deploys: under the
 * launcher's lock, from the install's bucket as it is now (another launcher
 * may have recorded a release, or an earlier job taken the install past its
 * first `pulumi up`, since this process first read it). A named version an
 * install provisioned since the wizard's check does not run is refused, as
 * the wizard refuses it up front ({@link decideInstallVersion}).
 *
 * @param requested - `--version`, or undefined for the CLI's own release.
 * @param record - the verified release ({@link installRecordFromManifest}).
 */
export function recordLaunchRelease(
  installId: string,
  projectId: string,
  requested: string | undefined,
  record: { readonly digests: ImageDigests; readonly version: string },
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  forgetCachedState(installId);
  const current = readMetadata(installId);
  if (!current) return { ok: false, error: `No install.json for install '${installId}'.` };
  const deployed = isStepDone(installId, `pulumi-up-${projectId}`);
  if (requested !== undefined) {
    const again = decideInstallVersion({
      requested,
      deployed,
      recordedVersion: current.releaseVersion,
    });
    if (again.kind === "refuse") return { ok: false, error: again.error };
  }
  if (
    launcherRecordsRelease({
      deployed,
      requested: requested !== undefined,
      recorded: recordedImageDigests(current),
    })
  ) {
    recordImageDigests(installId, record.digests, record.version);
  }
  return { ok: true };
}

/**
 * The release a wizard run is about to install, for the release-candidate
 * confirmation: the one `--version` names, else in job mode the CLI's own
 * release when the launcher records it for the new install (a release
 * candidate's installer installs that candidate). Null when the run installs
 * no new release: local mode without `--version` resolves `latest`, never a
 * candidate, and a provisioned install keeps what it runs.
 */
export function releaseToConfirm(input: {
  readonly decision: InstallVersionDecision;
  readonly runMode: "job" | "local";
  readonly cliVersion: string;
  readonly deployed: boolean;
  readonly recorded: ImageDigests | null;
}): string | null {
  if (input.decision.kind === "install") return input.decision.version;
  if (input.decision.kind !== "none" || input.runMode !== "job") return null;
  return launcherRecordsRelease({
    deployed: input.deployed,
    requested: false,
    recorded: input.recorded,
  })
    ? input.cliVersion
    : null;
}
