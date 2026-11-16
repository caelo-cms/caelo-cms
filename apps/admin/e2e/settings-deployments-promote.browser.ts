// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1591 — Settings → Deployments → Promote shows why a Publish live
 * was refused. It used to answer every refusal with a bare "Promote staging
 * → production failed." (HTTP 500), so an Owner could not tell an empty
 * staging from a closed quality gate.
 *
 * Specs run in parallel against one stack and any of them may Stage, so
 * staging's state is not this spec's to rely on. Nothing builds the `dev`
 * target, so promoting from it is "nothing staged" on every run: the same
 * refusal Promote gives before the first Stage, from the op's own check
 * (staging's preflight answer and the quality gate's reason are pinned in
 * promote-refusal.integration.test.ts).
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, ensureIsolatedOwner, ISOLATED_OWNER_PASSWORD } from "./helpers.js";

const OWNER_EMAIL = "deployments-promote-e2e-owner@example.com";

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("Promote with nothing to promote names the reason and the next step", async ({ page }) => {
  await login(page);
  await page.goto("/settings/deployments");
  await page.getByLabel("From", { exact: true }).selectOption("dev");
  await page.getByLabel("To", { exact: true }).selectOption("production");

  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/settings/deployments") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Promote", exact: true }).click(),
  ]);
  // A refusal, not a server fault.
  expect(response.status()).toBe(409);

  const alert = page.getByTestId("deploy-error");
  await expect(alert).toContainText("Promote dev → production refused:", { timeout: 30_000 });
  await expect(alert).toContainText("no succeeded build to promote from 'dev' — run Stage first");
});
