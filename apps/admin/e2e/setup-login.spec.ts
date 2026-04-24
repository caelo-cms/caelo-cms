// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/**
 * P2 verification flow exercised through a real browser. Runs against a
 * freshly-bootstrapped compose stack; we deliberately do NOT pre-seed users
 * so the `/setup` redirect is reachable.
 *
 * Note: this test requires the test DB to have zero users. The CI job runs
 * `bun run db:migrate` then spins up the preview server immediately, so the
 * only rows in `users` are whatever earlier integration tests left behind
 * under their own emails — none of them trigger `/setup`'s "is_setup_complete"
 * branch because `is_setup_complete` returns true as soon as any row exists.
 *
 * The smoke simply verifies: the app loads, login form renders, and the
 * standard redirect chain works. Full owner bootstrap is covered by the
 * integration suite against the same ops this browser hits.
 */
test("admin shell loads and redirects to login when users exist", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(500);
  await expect(page).toHaveURL(/\/(login|setup)/);
});

test("login page shows email + password fields", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("login with invalid credentials shows error banner", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("does-not-exist@example.com");
  await page.getByLabel("Password").fill("nope nope nope");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.locator(".error")).toContainText(/invalid/i);
});
