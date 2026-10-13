// SPDX-License-Identifier: MPL-2.0

/**
 * #684 — the Settings section (formerly Security). Pins three things an
 * operator relies on:
 *   - the overview shows every group, and pages that used to be unlinked
 *     (Domains & SSL with the staging host, the approvals inbox, external
 *     plugin installs) are now on it;
 *   - a sub-page opens from the overview with its operator-facing breadcrumb;
 *   - an old /security URL — bookmark, chat link, audit row — lands on the
 *     same page under /settings, query string intact, via a permanent 308.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const GROUPS = ["site", "publishing", "ai", "plugins", "people", "oversight"];

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

test("overview lists every group, including the formerly unlinked pages", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  for (const id of GROUPS) {
    await expect(page.getByTestId(`settings-group-${id}`)).toBeVisible();
  }
  for (const href of [
    "/settings/domains",
    "/settings/pending",
    "/settings/plugins/installations",
  ]) {
    await expect(page.locator(`[data-testid="settings-entry"][data-href="${href}"]`)).toBeVisible();
  }

  // The side nav says Settings now.
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await expect(sidebar.getByRole("link", { name: /^Settings$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Security$/ })).toHaveCount(0);

  // The filter finds the staging host by the operator's words.
  await page.getByTestId("settings-filter").fill("staging host");
  await expect(
    page.locator('[data-testid="settings-entry"][data-href="/settings/domains"]'),
  ).toBeVisible();
  await expect(page.getByTestId("settings-group-plugins")).toHaveCount(0);
});

test("a sub-page opens from the overview", async ({ page }) => {
  await page.goto("/settings");
  await page
    .getByTestId("settings-group-publishing")
    .getByRole("link", { name: /Domains & SSL/ })
    .click();
  await expect(page).toHaveURL("/settings/domains");
  await expect(page.getByRole("heading", { level: 1, name: /Domains & SSL/ })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(crumbs.getByText("Domains & SSL")).toBeVisible();
});

test("an old /security URL redirects permanently, keeping the query", async ({ page }) => {
  const res = await page.request.get("/security/ai/pricing?from=bookmark", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toBe("/settings/ai/pricing?from=bookmark");

  await page.goto("/security/staging?tab=1");
  await expect(page).toHaveURL("/settings/staging?tab=1");
  await expect(page.getByRole("heading", { level: 1, name: /Staging access/ })).toBeVisible();
});
