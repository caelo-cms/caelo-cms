// SPDX-License-Identifier: MPL-2.0

/**
 * P17.0 — single source of truth for the Caelo version.
 *
 * Bumped via `bun run scripts/release.ts <new-version>` which:
 *   1. Updates this constant + the root package.json `version`,
 *   2. Re-signs every Tier-1 plugin manifest under packages/plugins/,
 *   3. Builds + writes the release notes via `scripts/release-notes.ts`,
 *   4. Tags the commit as `vX.Y.Z`,
 *   5. Pushes — GitHub Actions takes over for the publish step.
 *
 * Read by:
 *   - admin's /security index page (header badge + about-modal),
 *   - cms-provision CLI's `version` subcommand,
 *   - User-Agent header on plugin-host's outbound HTTP calls,
 *   - Tier-1 manifest signing (the version is hashed into the
 *     signature payload so a manifest from version 0.5.0 can't be
 *     replayed as a 0.6.0 manifest).
 *
 * Format: SemVer 2.0.0. Pre-1.0 minor bumps are breaking; post-1.0
 * follow standard SemVer.
 */

export const CAELO_VERSION = "0.5.9";

/**
 * Deprecated alias for back-compat — early P17 work spelled this
 * `CALEO_VERSION` (typo of "Caelo"). New code should import
 * `CAELO_VERSION`. Kept as a re-export so existing callers keep
 * compiling; remove once external consumers have migrated.
 *
 * @deprecated use CAELO_VERSION
 */
export const CALEO_VERSION = CAELO_VERSION;

/**
 * Parsed shape — major/minor/patch + optional pre-release tag.
 * Stable interface for callers that need to feature-gate (rare —
 * Caelo doesn't do feature flags, but version-gating a deprecation
 * warning is a legitimate use).
 */
export interface CaeloVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly preRelease: string | null;
  readonly raw: string;
}

export function parseVersion(raw: string = CAELO_VERSION): CaeloVersion {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(raw);
  if (!m) {
    throw new Error(`invalid Caelo version: ${raw}`);
  }
  return {
    major: Number.parseInt(m[1] ?? "0", 10),
    minor: Number.parseInt(m[2] ?? "0", 10),
    patch: Number.parseInt(m[3] ?? "0", 10),
    preRelease: m[4] ?? null,
    raw,
  };
}
