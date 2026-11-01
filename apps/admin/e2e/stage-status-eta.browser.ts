// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1288 — the running Stage's step, progress and estimated time left
 * in the Live Edit Staging menu and on Settings → Deployments.
 *
 * Specs run in parallel against one stack and any of them may Stage, so a
 * seeded deploy run would not stay the newest. The two status reads are
 * answered with a fixed running Stage instead (`page.route`); the real
 * endpoint's shape is checked once. Asserted:
 * - the menu shows "Building pages …" with the estimate and its basis;
 * - the open menu reads the status once and then waits on live topics: no
 *   timer re-reads it (CLAUDE.md §11.B);
 * - the deployments page shows the same line for the run in its table.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  resetOverlayLayoutFor,
} from "./helpers.js";

const OWNER_EMAIL = "stage-status-eta-e2e-owner@example.com";
const RUN_ID = "00000000-0000-4000-8000-000000001288";

const runningStage = {
  runId: RUN_ID,
  targetName: "staging",
  status: "running",
  phase: "building",
  pagesDone: 812,
  pagesTotal: 1904,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  elapsedMs: 60_000,
  error: null,
  failedPhase: null,
  eta: { remainingMs: 100_000, basis: "this_run_rate", includesPublish: true },
  etaUnavailable: null,
};
const EXPECTED = "Building pages 812 of 1,904 — about 1 min 40 s left (from this run's pace)";

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("the real status endpoint answers with the Stage runs", async ({ page }) => {
  await login(page);
  const r = await page.request.get("/api/stage-status?limit=1");
  expect(r.status()).toBe(200);
  const body = (await r.json()) as { runs: unknown[] };
  expect(Array.isArray(body.runs)).toBe(true);
});

test("the Staging menu shows a running Stage's progress and time left, read once", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/stage-status*", (route) => {
    reads += 1;
    return route.fulfill({ json: { runs: [runningStage] } });
  });
  await login(page);
  await page.getByTestId("staging-menu").click();

  const progress = page.getByTestId("stage-run-progress");
  await expect(progress).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stage-run-progress-text")).toHaveText(EXPECTED);

  // No timer: while the menu stays open, nothing re-reads the status
  // (a `deploys` topic or focus would; neither happens here).
  const afterOpen = reads;
  await page.waitForTimeout(4_000);
  expect(reads).toBe(afterOpen);
});

test("a failed status read shows its reason in the menu", async ({ page }) => {
  await page.route("**/api/stage-status*", (route) =>
    route.fulfill({ status: 500, json: { error: "deploy.stage_status failed: test" } }),
  );
  await login(page);
  await page.getByTestId("staging-menu").click();
  await expect(page.getByTestId("stage-run-progress-error")).toHaveText(
    "deploy.stage_status failed: test",
  );
});

test("Settings → Deployments names a failed runs refresh and keeps its table", async ({ page }) => {
  await page.route("**/api/deploy-runs", (route) =>
    route.fulfill({ status: 500, json: { error: "deploy.list_runs failed: test" } }),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await login(page);
  await page.goto("/settings/deployments");
  await expect(page.getByTestId("deploy-runs-error")).toContainText(
    "deploy.list_runs failed: test",
    { timeout: 15_000 },
  );
  await expect(page.getByText("Recent runs", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("Settings → Deployments shows the running Stage's estimate in its row", async ({ page }) => {
  await page.route("**/api/deploy-runs", (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            id: RUN_ID,
            targetName: "staging",
            env: "staging",
            status: "running",
            startedAt: runningStage.startedAt,
            finishedAt: null,
            pageCount: null,
            fileCount: null,
            errorMessage: null,
            buildId: null,
            progress: { pagesDone: 812, pagesTotal: 1904 },
            buildKind: "site",
          },
        ],
        stageStatus: [runningStage],
        stageStatusError: null,
      },
    }),
  );
  await login(page);
  await page.goto("/settings/deployments");
  await expect(page.getByTestId("stage-run-eta")).toHaveText(EXPECTED, { timeout: 15_000 });
});
