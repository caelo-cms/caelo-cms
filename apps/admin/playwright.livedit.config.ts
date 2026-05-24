// SPDX-License-Identifier: MPL-2.0

/**
 * Real-AI end-to-end suite (issue #47).
 *
 * Drives the editor chat against the live Anthropic API (Opus 4.7,
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
 * Pinned Opus 4.7 model id for the livedit suite. PR #61 follow-up:
 * the suite ran against Sonnet 4.6 for cost reasons, but four of six
 * scenarios were tripping on AI-variance failures (the AI emitted a
 * structurally-correct page that didn't satisfy the structural floor —
 * missing `<h1>` in the homepage, missing `add_page` tool call in
 * nested-cta). With Opus 4.7 (the codebase's documented default per
 * `DEFAULT_MODEL.anthropic` in provider-resolver.ts), any remaining
 * scenario failure is a real bug — prompt regression, missing primer,
 * tool-schema drift, process bug — NOT model planning variance.
 *
 * Switch back to Sonnet 4.6 once the suite has been stable for a few
 * weeks AND we've validated the cost delta against the green-rate
 * improvement. Bump here + rerun the 10× determinism check from
 * `docs/internal/e2e-livedit.md` if you do.
 */
export const E2E_LIVEDIT_MODEL = "claude-opus-4-7";

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
  // Playwright per-test artifact dir — kept SIBLING (not parent) of
  // the HTML reporter dir below so Playwright's "HTML reporter output
  // folder clashes with tests output folder" guard doesn't fire.
  // global-setup writes admin.log under `test-results/livedit/` which
  // is also a sibling.
  outputDir: "test-results/livedit-tests",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/livedit/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    // Full-page on failure — the failing /edit screen has the chat
    // panel + live-edit overlay above the fold; without `fullPage`
    // the rendered hero/features/footer below the toolbar are clipped
    // out of the PR comment screenshot.
    screenshot: { mode: "only-on-failure", fullPage: true },
  },
});
