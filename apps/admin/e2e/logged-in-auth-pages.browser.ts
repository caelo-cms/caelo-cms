// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/**
 * Regression (2026-07-12): a signed-in user visiting /login or /setup
 * was dumped onto the setup form and stuck there. Cause:
 * users.is_setup_complete was system-only-scoped, so the request's
 * human ctx failed the check, and the loads' silent `: false`
 * fallback read that as "no owner yet". Signed-in visits to either
 * auth page must land back in the app, never on the setup form.
 */

test("signed-in user visiting /login lands in the app", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/login");
  await expect(page).toHaveURL(/\/(edit|$)/, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /create owner/i })).toHaveCount(0);
});

test("signed-in user visiting /setup never sees the setup form", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/setup");
  // /setup (complete) → /login → signed-in → /edit.
  await expect(page).toHaveURL(/\/(edit|$)/, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /create owner/i })).toHaveCount(0);
});
