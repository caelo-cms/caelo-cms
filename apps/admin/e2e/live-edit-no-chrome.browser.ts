// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.2 — /edit is the chrome-less surface. The (authed) layout
 * branches on the pathname so /edit renders WITHOUT the AppShell
 * sidebar/topbar. The route owns its own slim toolbar (wordmark + URL
 * + page picker + back-to-admin).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test("/edit has no AppShell sidebar/topbar; only the slim toolbar + iframe + overlay", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Sanity: dashboard DOES have the sidebar (Live edit link inside it).
  await expect(page.getByRole("link", { name: /^Live edit$/ })).toBeVisible();

  await page.goto("/edit");
  await expect(page).toHaveURL(/\/edit(\?|$)/, { timeout: 15_000 });

  // The chrome-less surface: AppShell sidebar entries are gone.
  await expect(page.getByRole("link", { name: /^Pages$/ })).not.toBeVisible();
  await expect(page.getByRole("link", { name: /^Modules$/ })).not.toBeVisible();
  await expect(page.getByRole("link", { name: /^Templates$/ })).not.toBeVisible();
  // The breadcrumb topbar (which renders the route segments) is also gone.
  await expect(page.getByRole("navigation", { name: /^Breadcrumb$/i })).not.toBeVisible();

  // The slim toolbar IS visible.
  await expect(page.locator('[data-testid="edit-toolbar"]')).toBeVisible();
  // URL display + back-to-admin link are present.
  await expect(page.locator('[data-testid="edit-url"]')).toBeVisible();
  await expect(page.locator('[data-testid="back-to-admin"]')).toBeVisible();
});
