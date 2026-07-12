// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — Owner-only `/security/structured` UI flow:
 *   1. Land on the index → see kind groups (nav-menus, tags, taxonomies,
 *      link lists, theme tokens).
 *   2. Click "+ New" on tags → fill the form → submit → returns to
 *      the list with the new set visible.
 *   3. Open the row's editor → confirm the JSON items round-trip.
 *   4. Delete the set from the list view.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

const ts = Date.now();
const NEW_SET_SLUG = `e2e-tags-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM structured_sets WHERE slug = \${process.env.NEW_SET_SLUG}\`;
    });
    await c.end();
    `,
    { NEW_SET_SLUG },
  );
});

test("Owner creates a tags set via /security/structured then opens its editor", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/security/structured");
  await expect(page.getByRole("heading", { name: "Structured data", exact: true })).toBeVisible();
  // Kind groups render. Headings, not getByText: the loose text match
  // ALSO hits the "No nav menus yet …" empty-state paragraph whenever
  // the group is empty (fresh DB / subset runs) — a latent strict-mode
  // violation that only order-dependent seeding papered over.
  await expect(page.getByRole("heading", { name: "Nav menus" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tags", exact: true })).toBeVisible();

  // Click the "+ New" link for the tags group. Each kind group is a
  // Card sibling. Locating by the heading then climbing to the
  // surrounding container survives Card-class renames.
  const tagsHeading = page.getByRole("heading", { name: "Tags", exact: true });
  const tagsCard = tagsHeading.locator("xpath=ancestor::*[.//a[contains(@href, 'tags/new')]][1]");
  await tagsCard.getByRole("link", { name: /\+ New/i }).click();
  await expect(page).toHaveURL(/\/security\/structured\/tags\/new$/);

  await page.getByLabel("Slug").fill(NEW_SET_SLUG);
  await page.getByLabel("Display name").fill("E2E Tags");
  // Replace the default `[]` with one valid tag item.
  const itemsField = page.getByLabel(/items \(JSON array\)/i);
  await itemsField.fill('[{"slug":"sample","displayName":"Sample"}]');
  await page.getByRole("button", { name: "Create set" }).click();

  // Redirected back to the index; the new row is visible.
  await expect(page).toHaveURL(/\/security\/structured$/);
  await expect(page.getByText(NEW_SET_SLUG, { exact: false }).first()).toBeVisible();

  // Open the row's editor and confirm the JSON items round-tripped.
  const newRow = page.locator("li").filter({ hasText: NEW_SET_SLUG });
  await newRow.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`/security/structured/tags/${NEW_SET_SLUG}$`));
  const itemsTextarea = page.getByLabel("items");
  const value = await itemsTextarea.inputValue();
  expect(value).toContain('"sample"');
  expect(value).toContain('"Sample"');
});
