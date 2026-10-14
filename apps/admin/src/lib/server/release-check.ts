// SPDX-License-Identifier: MPL-2.0

/**
 * Where Settings → Updates' "Check now" asks for the newest release.
 *
 * Production: GitHub (admin-core's default fetch). Test-only stand-in,
 * honoured outside production only (same gate as CAELO_E2E_FAKE_UPGRADER):
 * `CAELO_E2E_FAKE_RELEASE_CHECK=1` answers with a fixed release, so the
 * Playwright suite can press the button without GitHub deciding what it
 * sees (or spending the CI runner's unauthenticated API quota).
 */

import type { ReleaseFetch } from "@caelo-cms/admin-core";

/** The release the stand-in reports (the e2e suite seeds the same version). */
export const E2E_FAKE_RELEASE = {
  tag_name: "v99.0.0",
  html_url: "https://github.com/caelo-cms/caelo-cms/releases",
  body: "## Highlights\n\nA release reported by the e2e release-check stand-in.",
  published_at: "2026-10-01T00:00:00Z",
} as const;

const fakeFetch: ReleaseFetch = async () =>
  new Response(JSON.stringify(E2E_FAKE_RELEASE), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** The fetch "Check now" uses: undefined = the real one (GitHub). */
export function releaseCheckFetch(): ReleaseFetch | undefined {
  const fake =
    process.env.NODE_ENV !== "production" && process.env.CAELO_E2E_FAKE_RELEASE_CHECK === "1";
  return fake ? fakeFetch : undefined;
}
