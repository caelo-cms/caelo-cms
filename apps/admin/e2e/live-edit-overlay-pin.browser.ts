// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7 — clicking the "pin to bottom" affordance on the overlay snaps it
 * to the pinned-bottom layout. The choice persists per-user via the
 * user_preferences ops; reloading the page comes back already pinned.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test("overlay pin choice persists across reload", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/edit");
  await expect(page).toHaveURL(/\/edit(\?|$)/, { timeout: 15_000 });

  // Click the "Pin to bottom" toolbar button.
  const pinToBottom = page.getByRole("button", { name: /^Pin to bottom$/ });
  await expect(pinToBottom).toBeVisible({ timeout: 10_000 });
  await pinToBottom.click();

  // Give the debounced persist a moment to fire, then reload.
  await page.waitForTimeout(800);
  await page.reload();

  // After reload the overlay re-opens already pinned to bottom — the
  // active toolbar button has bg-accent.
  const pinToBottomAfter = page.getByRole("button", { name: /^Pin to bottom$/ });
  await expect(pinToBottomAfter).toHaveClass(/bg-accent/, { timeout: 10_000 });
});
