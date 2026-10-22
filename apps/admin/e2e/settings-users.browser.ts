// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/users create + delete through the real form actions. Regression
 * for the users/actors self-or-system RLS wall: both actions failed for a
 * human Owner ("Could not create user." / "Could not delete user.") until the
 * routes elevated to a system ctx after their users.manage check. The op-level
 * integration tests call the ops with system contexts directly, so only a
 * browser flow catches a route that drops the elevation again. The compose
 * stack is not behind Google IAP, so the post-change IAP sync is a no-op here.
 */

import { expect, test } from "@playwright/test";
import { acceptConfirm, clearLoginRateBucket } from "./helpers.js";

const OWNER_EMAIL = "dev-owner@example.com";
const OWNER_PASSWORD = "dev owner password";

test.beforeEach(() => {
  clearLoginRateBucket();
});

test("owner creates and deletes another user from /settings/users", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  const email = `e2e-user-${Date.now()}@example.com`;
  await page.goto("/settings/users");
  await page.getByLabel("Display name").fill("E2E Panel User");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password (min 10 chars)").fill("harbor-lantern-quill-71");
  await page.getByRole("button", { name: "Create user" }).click();

  const row = page.locator("li", { hasText: email });
  await expect(row).toBeVisible();
  await expect(page.getByText("Could not create user.")).toHaveCount(0);

  // Cancelling the confirm leaves the user in place — the Delete button
  // alone must never delete.
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toBeHidden();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Delete" }).click();
  await acceptConfirm(page);
  await expect(page.locator("li", { hasText: email })).toHaveCount(0);
  await expect(page.getByText("Could not delete user.")).toHaveCount(0);
});
