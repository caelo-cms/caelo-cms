// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/**
 * P2 verification flow exercised through a real browser.
 *
 *   1. /  → redirects to /setup (no users yet on a fresh CI DB)
 *   2. Fill the setup form, submit → redirects to /login
 *   3. Login with bad creds → "invalid email or password" error banner
 *   4. Login with good creds → dashboard renders the email + roles
 *
 * One sequential test so the steps share state. Other suites run integration-
 * level checks against the same op surface.
 */

test("setup → login → dashboard end-to-end", async ({ page }) => {
  const ts = Date.now();
  const email = `e2e-owner+${ts}@example.com`;
  const password = "e2e setup password";

  // 1. Landing on / redirects to /setup when there are zero users.
  await page.goto("/");
  await expect(page).toHaveURL(/\/(setup|login)/, { timeout: 15_000 });

  // If we landed on /login, something already created an owner — skip setup.
  if (page.url().endsWith("/login")) {
    test.skip(true, "DB already seeded with users; setup smoke is not exercisable");
  }

  // 2. Fill setup form.
  await page.getByLabel("Display name").fill("E2E Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: /create owner/i }).click();

  // After setup we're redirected to /login.
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  // 3. Bad credentials → error banner.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("WRONG password value");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.locator(".error")).toContainText(/invalid/i, { timeout: 15_000 });

  // 4. Good credentials → dashboard.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  // The signed-in identity renders on the dashboard, not in the
  // full-screen editor.
  await page.goto("/");
  await expect(page.getByText(email)).toBeVisible();
});
