// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/**
 * First-run AI wizard guards (/welcome/ai).
 *
 * The e2e seed always configures an active provider, so the happy
 * path (no provider → wizard form → save → /edit) cannot run inside
 * the fullyParallel suite without yanking providers out from under
 * concurrent specs. The two redirect guards ARE safely assertable
 * here; the form flow itself is covered by the action's server-side
 * validation and dogfood verification.
 */

test("unauthenticated /welcome/ai redirects to /login", async ({ page }) => {
  await page.goto("/welcome/ai");
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
});

test("with a configured provider, /welcome/ai redirects to /edit", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/welcome/ai");
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
});
