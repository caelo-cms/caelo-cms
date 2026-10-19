// SPDX-License-Identifier: MPL-2.0

/**
 * #724 rollout E — Settings → Internal links: the Owner sees the report of
 * the one-time link conversion the admin ran at boot, and a dry run
 * reports without changing anything.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner reads the link conversion report and runs a dry run", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);

  await page.goto("/settings");
  await page.getByRole("link", { name: /Internal links/ }).first().click();
  await expect(page).toHaveURL(/\/settings\/links/);
  await expect(page.getByRole("heading", { name: "Internal links" })).toBeVisible();

  await page.getByRole("button", { name: "Check again (dry run)" }).click();
  await expect(page.getByText(/^Dry run: \d+ link\(s\) would be converted/)).toBeVisible();
  await expect(page.getByText(/Dry run \(nothing changed\)/)).toBeVisible();
});
