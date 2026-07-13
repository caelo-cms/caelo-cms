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
 * Model id for the livedit suite — pinned to the codebase's documented
 * default (`DEFAULT_MODEL.anthropic` in provider-resolver.ts), so the
 * suite exercises exactly the model the product actually ships. The
 * default moved to Sonnet 5 in #246 (with adaptive thinking); the suite
 * follows so any scenario failure is a real bug — prompt regression,
 * missing primer, tool-schema drift, process bug — NOT a variance gap
 * between the test model and the shipped model.
 *
 * History: earlier this was Sonnet 4.6 (cost), which tripped four of
 * six scenarios on AI-variance (missing `<h1>`, missing `add_page`);
 * then Opus 4.7 (the prior default). If the green rate regresses on
 * Sonnet 5, rerun the 10× determinism check from
 * `docs/internal/e2e-livedit.md` before assuming it's a product bug.
 */
export const E2E_LIVEDIT_MODEL = "claude-sonnet-5";

export default defineConfig({
  testDir: "./e2e-livedit",
  testMatch: "**/*.browser.ts",
  globalSetup: "./e2e-livedit/global-setup.ts",
  globalTeardown: "./e2e-livedit/global-teardown.ts",
  // Per-test timeout — a full chat→Stage→Publish→re-edit loop with
  // real Anthropic latency can run 3-4 min on a cold compose stack.
  // 600s since #155: compose turns now legitimately include up to two
  // screenshot self-review rounds (browser-mediated capture + a model
  // turn each), which pushed the heaviest scenario past the old 300s
  // budget reproducibly (PR #175 runs). The timeout's job is to catch
  // HANGS, not to race the design loop — 600s still does that.
  timeout: 600_000,
  fullyParallel: false,
  // Single worker. `fullyParallel: false` alone is NOT enough — that
  // only stops within-file parallelism; Playwright still spawns up to
  // `workers` (auto = cores/2) processes for cross-file parallelism.
  // Scenarios all hit the same admin instance + DB, so concurrent runs
  // race on chat_sessions, pages, modules, content_instances etc.
  // The unique-constraint and "AI produced nothing" failures we chased
  // for an hour all dissolve once scenarios run sequentially. Verified
  // local: `Running 6 tests using 5 workers` line in the log was the
  // tell.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // 1 retry = 2 attempts total. PR #61 follow-up — we ran the suite
  // at retries=2 (3 attempts) while debugging Sonnet's variance; now
  // on Opus 4.7 the assertions are tight enough that anything failing
  // twice in a row is signal, not noise (real bug, prompt regression,
  // process issue). More retries past 2 papers over real problems
  // and burns API tokens — see CLAUDE.md §4 (root-cause bugs, no
  // quick fixes).
  retries: 1,
  // Playwright per-test artifact dir — kept SIBLING (not parent) of
  // the HTML reporter dir below so Playwright's "HTML reporter output
  // folder clashes with tests output folder" guard doesn't fire.
  // global-setup writes admin.log under `test-results/livedit/` which
  // is also a sibling.
  outputDir: "test-results/livedit-tests",
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/livedit/playwright-report", open: "never" }],
    // PR #61 follow-up — machine-readable per-scenario timings + statuses
    // for the post-run stats table the workflow embeds in the PR comment.
    // Lives next to admin.log under test-results/livedit/ so the artifact
    // upload picks it up alongside everything else.
    ["json", { outputFile: "test-results/livedit/playwright-report.json" }],
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
