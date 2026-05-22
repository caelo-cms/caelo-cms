// SPDX-License-Identifier: MPL-2.0

/**
 * Playwright globalSetup: runs once before any spec.
 *
 * 1. Seeds (or refreshes) the `dev-owner@example.com` account so every spec
 *    has a known login without depending on whatever rows happen to be in
 *    the dev DB.
 * 2. Clears the per-IP login rate-limit bucket so back-to-back runs do not
 *    trip the 5-per-5-minutes cap.
 *
 * Implementation lives in `./_seed.ts` and is shared with the
 * `e2e-livedit/` suite (issue #47) so both surfaces use exactly the same
 * dev-owner seed.
 */

import { SETUP_SCRIPT, loadEnvFile, runBun } from "./_seed.js";

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL must be set for Playwright e2e");
  }
  runBun(SETUP_SCRIPT);
}
