// SPDX-License-Identifier: MPL-2.0

/**
 * What the auto-update scheduler knows about a release before it queues an
 * install (epic #696 Phase 5): whether it is a security fix, carries
 * destructive migrations, or changes the cloud setup — read from the
 * release manifest in the public registry.
 *
 * Read, not verified: the admin image ships no cosign, and it does not need
 * to — these facts only decide *when to ask*. The upgrader job verifies the
 * signed manifest and re-checks every one of them before it changes
 * anything (provisioning upgrader-assess.ts). A registry that lies here can
 * at most make the scheduler ask early for a release the job then refuses.
 */

import {
  fetchReleaseArtifact,
  isNewerVersion,
  isSecurityRelease,
  parseReleaseManifest,
  type ReleaseArtifactDeps,
  type ReleaseFacts,
  type ReleaseManifest,
} from "@caelo-cms/shared";

/** What {@link readReleaseFacts} needs to know about this install. */
export interface ReleaseFactsInput {
  readonly installedVersion: string;
  readonly targetVersion: string;
  /**
   * `CAELO_PROVIDER`. A self-hosted install has no cloud setup apart from
   * the release (its Compose file is rendered by the target release's own
   * CLI in the same run), so a release never "changes the cloud setup" there.
   */
  readonly provider: string | undefined;
}

/** Fetches a manifest; null + why when it cannot. Injectable for tests. */
export type ManifestReader = (
  version: string,
) => Promise<{ ok: true; manifest: ReleaseManifest } | { ok: false; message: string }>;

/** A {@link ManifestReader} over the registry, caching what it read (manifests never change). */
export function registryManifestReader(deps: ReleaseArtifactDeps): ManifestReader {
  const cache = new Map<string, ReleaseManifest>();
  return async (version) => {
    const hit = cache.get(version);
    if (hit) return { ok: true, manifest: hit };
    const artifact = await fetchReleaseArtifact(version, deps);
    if (!artifact.ok) return { ok: false, message: artifact.error.message };
    const parsed = parseReleaseManifest(artifact.manifestBytes, version);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    cache.set(version, parsed.manifest);
    return { ok: true, manifest: parsed.manifest };
  };
}

/**
 * The facts of `targetVersion` relative to the installed release, or why
 * they could not be read (the scheduler then installs nothing and says so).
 */
export async function readReleaseFacts(
  input: ReleaseFactsInput,
  read: ManifestReader,
): Promise<ReleaseFacts | { unavailable: string }> {
  const target = await read(input.targetVersion);
  if (!target.ok) return { unavailable: target.message };
  const m = target.manifest;
  const lastContract = m.migrations.lastContractVersion;
  const contractMigrations =
    m.migrations.contract ||
    (lastContract !== null && isNewerVersion(lastContract, input.installedVersion));

  let infraChange: boolean | null;
  if (input.provider === "self-hosted") {
    infraChange = false;
  } else {
    // The installed release's manifest names the contract this install was
    // converged to when it was installed. Releases from before the signed
    // manifest have none: then the upgrader decides from install.json.
    const installed = await read(input.installedVersion);
    infraChange = installed.ok
      ? m.infraContractVersion > installed.manifest.infraContractVersion
      : null;
  }
  return {
    security: isSecurityRelease(m),
    advisories: m.advisories,
    contractMigrations,
    infraChange,
  };
}
