// SPDX-License-Identifier: MPL-2.0

/**
 * Where Settings → Updates' "Check now" asks for the newest release.
 *
 * Production: GitHub (admin-core's default fetch). Test-only stand-in,
 * honoured outside production only (same gate as CAELO_E2E_FAKE_UPGRADER):
 * `CAELO_E2E_FAKE_RELEASE_CHECK=1` answers with a fixed release, so the
 * Playwright suite can press the button without GitHub deciding what it
 * sees (or spending the CI runner's unauthenticated API quota). The same
 * gate answers "no manifest" for the release's route (#817): the suite seeds
 * `release_check_cache.latest_infra_change` itself, and the registry has no
 * v99.0.0 to read.
 */

import {
  type ManifestReader,
  type ReleaseFetch,
  registryManifestReader,
} from "@caelo-cms/admin-core";

/** The release the stand-in reports (the e2e suite seeds the same version). */
export const E2E_FAKE_RELEASE = {
  tag_name: "v99.0.0",
  html_url: "https://github.com/caelo-cms/caelo-cms/releases",
  // The shape scripts/release.ts writes; the page shows it in Owner words.
  body: "### Fixes\n- 0a1b2c3d a fix reported by the e2e release-check stand-in (#1)\n",
  published_at: "2026-10-01T00:00:00Z",
} as const;

const fakeFetch: ReleaseFetch = async () =>
  new Response(JSON.stringify(E2E_FAKE_RELEASE), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const isFake = (): boolean =>
  process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_RELEASE_CHECK === "1";

/** The fetch "Check now" uses: undefined = the real one (GitHub). */
export function releaseCheckFetch(): ReleaseFetch | undefined {
  return isFake() ? fakeFetch : undefined;
}

const fakeManifests: ManifestReader = async (version) => ({
  ok: false,
  message: `the e2e release-check stand-in has no manifest for v${version}`,
});

/**
 * One manifest reader per admin process, shared by the release check, "Check
 * now" and the auto-update scheduler: it caches what it read, and a
 * release's manifest never changes.
 */
let registryReader: ManifestReader | null = null;

/** The manifest reader for a release's route and facts (the registry, or the e2e stand-in). */
export function releaseManifestReader(): ManifestReader {
  if (isFake()) return fakeManifests;
  registryReader ??= registryManifestReader({ fetch: (url, init) => fetch(url, init) });
  return registryReader;
}
