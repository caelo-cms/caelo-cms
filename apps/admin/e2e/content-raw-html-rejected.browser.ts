// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

/**
 * §3.1 invariant — user-facing surface.
 *
 *  - The page-create form exposes no `html` input at all (so an editor cannot
 *    paste raw HTML "into" a page).
 *  - The page-edit form exposes no `html` input either.
 *  - Templates DO accept HTML — the Module/Template layers are where raw HTML
 *    legitimately lives — so the editor for templates DOES carry an HTML field
 *    by design. Asserting both halves keeps the layered model honest.
 *
 * The lower-layer Validator regression (Zod `.strict()` rejects an `html`
 * field smuggled into a `pages.create` op call) lives in the integration
 * suite at packages/admin-core/src/__tests__/content-no-raw-html.integration.test.ts —
 * it can't be exercised through the form layer because the SvelteKit action
 * only forwards a fixed allowlist of fields to the op. The user-visible
 * behaviour proven here is what protects the editor surface.
 */

const ts = Date.now();
const TPL_SLUG = `e2e-noraw-tpl-${ts}`;
const PAGE_SLUG = `e2e-noraw-page-${ts}`;

test("the page editor exposes no `html` field on create or edit", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // Create a template (templates legitimately carry HTML so this form *does*
  // have an html field — confirms the assertion is targeting pages, not all
  // content surfaces).
  await page.goto("/content/templates");
  await expect(page.locator('textarea[name="html"]')).toHaveCount(1);
  await page.getByLabel("Slug").fill(TPL_SLUG);
  await page.getByLabel("Display name").fill("E2E NoRaw Template");
  await page.getByLabel(/HTML/).fill(`<body><caelo-slot name="content">_</caelo-slot></body>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/templates\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Pages list/create — assert no html field anywhere on the form surface.
  await page.goto("/content/pages");
  await expect(page.locator('input[name="html"], textarea[name="html"]')).toHaveCount(0);

  // Drive the page-create form through valid fields only.
  await page.getByLabel("Slug").fill(PAGE_SLUG);
  await page.getByLabel("Title").fill("NoRaw Page");
  const tplOption = await page
    .locator("select[name=templateId] option")
    .filter({ hasText: TPL_SLUG })
    .first();
  await page.getByLabel("Template").selectOption((await tplOption.getAttribute("value")) ?? "");
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/pages\/[0-9a-f-]+$/, { timeout: 15_000 });

  // The page editor itself also carries no html field.
  await expect(page.locator('input[name="html"], textarea[name="html"]')).toHaveCount(0);
});
