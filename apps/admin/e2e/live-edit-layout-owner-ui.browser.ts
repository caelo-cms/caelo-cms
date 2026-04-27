// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 review pass — Owner end-to-end UI flow:
 *   1. /security/layouts lists the seeded layouts.
 *   2. New-layout form creates `e2e-campaign-<ts>` with header /
 *      content / footer blocks.
 *   3. The new layout appears in the list.
 *   4. Delete it via the row's Delete button (no templates bind to
 *      it, so the op succeeds and the row disappears).
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

const ts = Date.now();
const NEW_SLUG = `e2e-campaign-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(() => {
  // Hard cleanup in case the spec failed mid-flight before the delete.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM layout_blocks WHERE layout_id IN (
        SELECT id FROM layouts WHERE slug = \${process.env.NEW_SLUG}
      )\`;
      await tx\`DELETE FROM layouts WHERE slug = \${process.env.NEW_SLUG}\`;
    });
    await c.end();
    `,
    { NEW_SLUG },
  );
});

test("Owner creates a layout via /security/layouts/new then deletes it", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/security/layouts");
  await expect(page.getByRole("heading", { name: "Layouts", exact: true })).toBeVisible();
  // Three seeded layouts visible.
  await expect(page.getByText("site-default", { exact: false }).first()).toBeVisible();

  // Open the new-layout form.
  await page.getByRole("link", { name: "New layout" }).click();
  await expect(page).toHaveURL(/\/security\/layouts\/new$/);

  await page.getByLabel("Slug").fill(NEW_SLUG);
  await page.getByLabel("Display name").fill("E2E Campaign Layout");
  await page
    .getByLabel("HTML")
    .fill(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><header><caelo-slot name="header">_</caelo-slot></header><main><caelo-slot name="content">_</caelo-slot></main><footer><caelo-slot name="footer">_</caelo-slot></footer></body></html>',
    );
  // Default block rows already include header/content/footer; submit.
  await page.getByRole("button", { name: "Create layout" }).click();

  // Redirected back to the list, the new layout is visible.
  await expect(page).toHaveURL(/\/security\/layouts$/);
  await expect(page.getByText(NEW_SLUG, { exact: false }).first()).toBeVisible();

  // Delete it (no templates reference it, so the button is enabled).
  const row = page.locator("li").filter({ hasText: NEW_SLUG });
  await row.getByRole("button", { name: "Delete" }).click();

  // The row should no longer be present.
  await expect(page.getByText(NEW_SLUG, { exact: false })).toHaveCount(0);
});
