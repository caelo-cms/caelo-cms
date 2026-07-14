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

import { loadEnvFile, POST_CHAT_SEED_SCRIPT, runBun, SETUP_SCRIPT } from "./_seed.js";

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL must be set for Playwright e2e");
  }
  runBun(SETUP_SCRIPT);
  // v0.11.4 (issue #76 follow-up) — mock-AI specs don't exercise the
  // chat-first cold-start path; the cold-start gate on module-creation
  // tools (build_page, add_module_to_layout, etc.) would
  // block specs that rely on those tools without first calling
  // set_site_identity + set_theme_tokens. Fast-forward past cold-start
  // here. The real-AI e2e-livedit suite intentionally skips this so it
  // exercises the gate.
  runBun(POST_CHAT_SEED_SCRIPT);
}
