// SPDX-License-Identifier: MPL-2.0

/**
 * Password change + self-service reset, end-to-end through the real stack.
 *
 * These flows deliberately exercise only paths that DON'T mutate the shared
 * dev-owner credential (other specs depend on it): the forgot-password
 * confirmation, an invalid reset token, a wrong current password, and a
 * strength rejection (the op checks strength before writing, so the password
 * is never changed). The happy-path token mechanics are covered by
 * `password-reset.integration.test.ts` against a real Postgres.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const OWNER_EMAIL = "dev-owner@example.com";
const OWNER_PASSWORD = "dev owner password";

async function signInAsOwner(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test.beforeEach(() => {
  clearLoginRateBucket();
});

test.describe("password reset + change", () => {
  test("login links to forgot-password, which returns a generic confirmation", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: /forgot your password/i }).click();
    await expect(page).toHaveURL("/forgot");

    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByRole("button", { name: /send reset link/i }).click();
    // Same message whether or not the account exists (no enumeration).
    await expect(page.getByText(/if an account exists/i)).toBeVisible();
  });

  test("reset page rejects an invalid or expired token", async ({ page }) => {
    await page.goto("/reset?token=definitely-not-a-real-token");
    await page.getByLabel("New password", { exact: true }).fill("brand-new-secret-9");
    await page.getByLabel("Confirm new password").fill("brand-new-secret-9");
    await page.getByRole("button", { name: /set new password/i }).click();
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
  });

  test("account: a wrong current password is rejected (no change)", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/account");
    await page.getByLabel("Current password").fill("wrong-current-pw");
    await page.getByLabel("New password", { exact: true }).fill("a-fine-new-secret-9");
    await page.getByLabel("Confirm new password").fill("a-fine-new-secret-9");
    await page.getByRole("button", { name: /change password/i }).click();
    await expect(page.getByText(/current password is incorrect/i)).toBeVisible();
  });

  test("account: a weak new password is rejected on strength (no change)", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/account");
    // Correct current so we reach the strength check — which runs BEFORE any
    // write, so the dev-owner password stays intact for other specs.
    await page.getByLabel("Current password").fill(OWNER_PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill("password123");
    await page.getByLabel("Confirm new password").fill("password123");
    await page.getByRole("button", { name: /change password/i }).click();
    await expect(page.getByText(/too common/i)).toBeVisible();
  });
});
