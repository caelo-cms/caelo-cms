// SPDX-License-Identifier: MPL-2.0

/**
 * An open tab renews its CSRF form token in the background
 * (#lib/csrf-refresh.ts). That makes every page's `data` a new object; the
 * theme editor re-synced its unsaved token edits from `data.theme` on every
 * such change, so the refresh would have thrown away what the Owner was
 * editing. The edits survive; the forms carry the new token.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test("regression: unsaved theme edits survive the background CSRF token refresh", async ({
  page,
}) => {
  clearLoginRateBucket();
  await page.clock.install();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  await page.goto("/design/themes/site-default");
  const token = page.locator('input[name="_csrf"]').first();
  const before = await token.inputValue();
  const primary = page.locator("#color-primary");
  await primary.fill("#123456");

  await page.clock.fastForward("31:00");
  await expect(token).not.toHaveValue(before);
  await expect(primary).toHaveValue("#123456");
});
