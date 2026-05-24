// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

/**
 * P4 verification flow: edit a module twice, open the Advanced History
 * drawer, click into the v1 entry, hit "Revert this module", then verify
 * the live module HTML is back to v1 and a new revert snapshot appears at
 * the top of the timeline.
 */

const ts = Date.now();
const TPL_SLUG = `e2e-h-tpl-${ts}`;
const MOD_SLUG = `e2e-h-mod-${ts}`;
const PAGE_SLUG = `e2e-h-page-${ts}`;
const V1_TEXT = `HELLO_V1_${ts}`;
const V2_TEXT = `HELLO_V2_${ts}`;

test("Advanced History drawer reverts a module", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Need a template + slot so the test mirrors the typical flow.
  await page.goto("/content/templates");
  await page.getByLabel("Slug").fill(TPL_SLUG);
  await page.getByLabel("Display name").fill("E2E History Template");
  await page.getByLabel(/HTML/).fill(`<body><caelo-slot name="content">_</caelo-slot></body>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/templates\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByRole("button", { name: /save blocks/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // Create the module at v1 then update to v2.
  await page.goto("/content/modules");
  await page.getByLabel("Slug").fill(MOD_SLUG);
  await page.getByLabel("Display name").fill("E2E History Module");
  await page.getByLabel("HTML").fill(`<p>${V1_TEXT}</p>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/modules\/[0-9a-f-]+$/, { timeout: 15_000 });
  const moduleId = page.url().split("/").at(-1) ?? "";
  expect(moduleId).toMatch(/^[0-9a-f-]{36}$/);

  // Edit to v2.
  await page.locator('textarea[name="html"]').fill(`<p>${V2_TEXT}</p>`);
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // Open the history drawer; v2 should be the most recent module-update entry.
  await page.goto("/content/history");
  await expect(page.getByRole("heading", { name: "Advanced history" })).toBeVisible();
  // The v1 create snapshot description matches "modules.create slug=…".
  const v1Link = page.getByRole("link", { name: "View entities" }).nth(
    // index of the v1 snapshot — list is reverse-chrono so it's after v2 update + page-edit
    // entries from earlier setup. Find by description text instead.
    0,
  );
  void v1Link; // unused — we'll find by description instead

  // Click the v1 snapshot's "View entities" link by locating its <li>.
  const v1Item = page.locator("li").filter({ hasText: `modules.create slug=${MOD_SLUG}` });
  await v1Item.getByRole("link", { name: "View entities" }).click();
  await expect(page).toHaveURL(/\/content\/history\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Revert this module.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /revert this module/i }).click();
  await expect(page.getByText(/Module reverted\./)).toBeVisible({ timeout: 15_000 });

  // Confirm live module is back to v1.
  //
  // v0.12.2 — modules.create runs the conservative extractor when no
  // explicit fields are supplied, so the persisted v1 HTML is the
  // templatised form (`<p>{{body}}</p>` with a `body` field whose
  // default is V1_TEXT) — NOT the literal `<p>${V1_TEXT}</p>` the form
  // submitted. After revert, the textarea shows the v1 state, which
  // is the templatised form. The literal text lives in the field
  // default, which is what the renderer will substitute at preview
  // time.
  await page.goto(`/content/modules/${moduleId}`);
  await expect(page.locator('textarea[name="html"]')).toHaveValue(`<p>{{body}}</p>`);

  // History timeline now contains a "revert module → …" entry. Other
  // parallel specs may emit unrelated snapshots so we filter for the
  // revert row rather than asserting on the global first li.
  await page.goto("/content/history");
  const revertItem = page
    .locator("li")
    .filter({ hasText: /revert module/i })
    .first();
  await expect(revertItem).toBeVisible();

  // Cleanup the page slug if any test created it (none here, but defensive).
  void PAGE_SLUG;
});
