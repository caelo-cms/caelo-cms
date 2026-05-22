// SPDX-License-Identifier: MPL-2.0

/**
 * Real-AI end-to-end suite (issue #47).
 *
 * Drives the editor chat against the live Anthropic API (Sonnet 4.6,
 * temperature=0) to catch the regression classes the mock-AI suite at
 * `e2e/` cannot — empty AI turns, orphan locks after Stage, missing
 * tool primers — and verifies the published result with one closing
 * LLM-vision verdict.
 *
 * Differs from the mock-AI config in two structural ways:
 *
 *   - **No `webServer` block.** `global-setup.ts` spawns the admin
 *     (`bun run build/index.js`) itself and pipes stdio into
 *     `test-results/livedit/admin.log` so `assertNoChatRunnerDiagWarnings`
 *     can grep the captured stderr after a turn finishes. Playwright's
 *     own `webServer` child stdio is not reachable from spec code.
 *
 *   - **Retries = 2** (vs 0 in the smoke suite). Real-AI calls have
 *     irreducible variance even at temperature=0; two retries keep the
 *     PR check meaningful while structural assertions defend against
 *     content drift.
 */

import { defineConfig } from "@playwright/test";

/**
 * Pinned Sonnet 4.6 model id for the livedit suite. Matches the
 * codebase's undated convention (DEFAULT_MODEL.anthropic =
 * "claude-opus-4-7" in provider-resolver.ts). If Anthropic ships a new
 * Sonnet point release that materially changes tool-call planning, bump
 * here and rerun the 10× determinism check from docs/internal/e2e-livedit.md.
 */
export const E2E_LIVEDIT_MODEL = "claude-sonnet-4-6";

export default defineConfig({
  testDir: "./e2e-livedit",
  testMatch: "**/*.browser.ts",
  globalSetup: "./e2e-livedit/global-setup.ts",
  globalTeardown: "./e2e-livedit/global-teardown.ts",
  // Per-test timeout — a full chat→Stage→Publish→re-edit loop with
  // real Anthropic latency can run 3-4 min on a cold compose stack.
  timeout: 300_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/livedit/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
