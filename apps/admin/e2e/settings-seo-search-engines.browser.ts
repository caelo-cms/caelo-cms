// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → SEO: the Owner switches the feed of the latest changes and the
 * IndexNow submissions, and sees what the last Publish lives told search
 * engines (docs/dev/search-engine-feed.md).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner switches the feed and IndexNow and sees the notifications card", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);

  await page.goto("/settings/seo");
  await expect(page.getByRole("heading", { name: "SEO settings" })).toBeVisible();
  await expect(page.getByTestId("search-notifications")).toBeVisible();

  const feed = page.getByLabel("Publish a feed of the latest changes (/feed.xml)");
  const indexNow = page.getByLabel("Tell IndexNow search engines what changed");
  // Both are on for a new site.
  await expect(feed).toBeChecked();
  await expect(indexNow).toBeChecked();

  const save = page.getByRole("button", { name: "Save settings" });
  await feed.uncheck();
  await indexNow.uncheck();
  await save.click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(feed).not.toBeChecked();
  await expect(indexNow).not.toBeChecked();

  // Back on, as the rest of the suite expects.
  await feed.check();
  await indexNow.check();
  await save.click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(feed).toBeChecked();
  await expect(indexNow).toBeChecked();
});
