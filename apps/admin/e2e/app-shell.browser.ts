// SPDX-License-Identifier: MPL-2.0

/**
 * P6.5 — pins the AppShell as a first-class surface:
 *   - Sidebar nav items present (gated by Owner perms).
 *   - Clicking a nav item navigates and the URL updates.
 *   - Dark-mode toggle persists across reload.
 *
 * The reviewer-permission cut would belong here too but the existing
 * content-reviewer-readonly.browser.ts already covers that side.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner sees AppShell with sidebar nav, can navigate, dark mode persists", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Sidebar nav contains the expected items for an Owner.
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await expect(sidebar.getByRole("link", { name: /^Dashboard$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Pages$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Modules$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Templates$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Chats$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Deployments$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Security$/ })).toBeVisible();

  // Click Pages → URL updates.
  await sidebar.getByRole("link", { name: /^Pages$/ }).click();
  await expect(page).toHaveURL("/content/pages", { timeout: 5_000 });

  // Toggle dark mode → reload → still dark.
  await page.getByRole("button", { name: /toggle theme/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 2_000 });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 2_000 });

  // Restore light so the next spec starts clean.
  await page.getByRole("button", { name: /toggle theme/i }).click();
});
