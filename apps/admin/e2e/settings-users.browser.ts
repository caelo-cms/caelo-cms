// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/users create + delete through the real form actions. Regression
 * for the users/actors self-or-system RLS wall: both actions failed for a
 * human Owner ("Could not create user." / "Could not delete user.") until the
 * routes elevated to a system ctx after their users.manage check. The op-level
 * integration tests call the ops with system contexts directly, so only a
 * browser flow catches a route that drops the elevation again. The compose
 * stack is not behind Google IAP; the post-change IAP sync runs against the
 * suite's stand-in job (lib/server/google-iap.ts, CAELO_E2E_GOOGLE_IAP).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

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

  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("li", { hasText: email })).toHaveCount(0);
  await expect(page.getByText("Could not delete user.")).toHaveCount(0);
});

/**
 * #970 — a user whose address has no Google account. The suite's stand-in
 * sync job (lib/server/google-iap.ts, CAELO_E2E_GOOGLE_IAP) refuses every
 * `no-google-…` address the way Google refuses an address without a Google
 * account. The create form says so right after saving (Google offers no
 * check before), the page names the user with Change email / Delete
 * instead of a blanket "sync failed", and changing the email clears it.
 */
test("#970: a user without a Google account is named right after creation, with the fix", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  const stamp = Date.now();
  const email = `no-google-${stamp}@example.com`;
  const fixed = `e2e-google-${stamp}@example.com`;
  await page.goto("/settings/users");
  await expect(page.getByTestId("users-create-google-hint")).toContainText(
    "Google offers no way to check an address before saving",
  );
  await page.getByLabel("Display name").fill("E2E No Google");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password (min 10 chars)").fill("harbor-lantern-quill-71");
  await page.getByRole("button", { name: "Create user" }).click();

  await expect(page.getByTestId("users-created-no-google-account")).toContainText(
    `${email} was created, but Google has no account with that address`,
  );
  const list = page.getByTestId("users-no-google-account");
  await expect(list).toContainText("These users have no Google account and cannot sign in:");
  const row = page.getByTestId("users-no-google-account-row").filter({ hasText: email });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Delete" })).toBeVisible();
  // Not a blanket failure: the run applied everyone else.
  await expect(page.getByTestId("operator-access-sync-failed")).toHaveCount(0);
  await expect(page.getByText("IAP may not match this list")).toHaveCount(0);

  await row.getByRole("button", { name: "Change email" }).click();
  await row.getByLabel("Google account address").fill(fixed);
  await row.getByRole("button", { name: "Save email" }).click();

  await expect(
    page.getByTestId("users-no-google-account-row").filter({ hasText: email }),
  ).toHaveCount(0);
  const user = page.locator("li", { hasText: fixed });
  await expect(user).toBeVisible();
  await user.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.locator("li", { hasText: fixed })).toHaveCount(0);
});
