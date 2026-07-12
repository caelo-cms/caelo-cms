// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

/**
 * P3 verification flow: dev owner logs in, creates a template + module + page,
 * composes the page from the module, and opens the preview endpoint to assert
 * the composed output contains the module HTML inside the slot.
 *
 * Uses unique slugs per run so reruns against a non-wiped DB do not collide.
 * Dev-owner seed + login-bucket clear handled by Playwright globalSetup.
 */

const ts = Date.now();
const TPL_SLUG = `e2e-tpl-${ts}`;
const MOD_SLUG = `e2e-mod-${ts}`;
const PAGE_SLUG = `e2e-page-${ts}`;
const MODULE_TEXT = `HELLO_${ts}`;

test("compose a page from a module and preview it", async ({ page, request }) => {
  // Sign in as the dev owner (seeded by `bun run --filter @caelo-cms/admin seed:dev`).
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // Create a template.
  await page.goto("/content/templates");
  await page.getByLabel("Slug").fill(TPL_SLUG);
  await page.getByLabel("Display name").fill("E2E Template");
  await page
    .getByLabel(/HTML/)
    .fill(
      `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    );
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/templates\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Save the block list.
  await page.getByRole("button", { name: /save blocks/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // Create a module.
  await page.goto("/content/modules");
  await page.getByLabel("Slug").fill(MOD_SLUG);
  await page.getByLabel("Display name").fill("E2E Module");
  await page.getByLabel("HTML").fill(`<p>${MODULE_TEXT}</p>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/modules\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Create a page bound to the new template.
  await page.goto("/content/pages");
  await page.getByLabel("Slug").fill(PAGE_SLUG);
  await page.getByLabel("Title").fill("E2E Page");
  // Select the option whose label includes our template slug.
  const tplOption = await page
    .locator("select[name=templateId] option")
    .filter({ hasText: TPL_SLUG })
    .first();
  const tplValue = (await tplOption.getAttribute("value")) ?? "";
  expect(tplValue).not.toBe("");
  await page.getByLabel("Template").selectOption(tplValue);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/pages\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Add the module to the `content` block via the layout dropdown, then save.
  const modOption = await page.locator("select option").filter({ hasText: MOD_SLUG }).first();
  const modValue = (await modOption.getAttribute("value")) ?? "";
  expect(modValue).not.toBe("");
  await page.getByLabel("Add module").selectOption(modValue);
  await page.getByRole("button", { name: /save layout/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // Extract the page id from the editor URL and hit the preview endpoint with
  // the authenticated browser context's cookies.
  const editorUrl = new URL(page.url());
  const pathParts = editorUrl.pathname.split("/").filter(Boolean);
  const pageId = pathParts[pathParts.length - 1] ?? "";
  expect(pageId).toMatch(/^[0-9a-f-]{36}$/);
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const previewUrl = `${editorUrl.origin}/content/pages/${pageId}/preview`;
  const res = await request.get(previewUrl, { headers: { cookie: cookieHeader } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/html");
  const body = await res.text();
  // P6.7 — every module's outermost element carries data-caelo-module-id.
  expect(body).toContain(`>${MODULE_TEXT}</p>`);
  expect(body).toContain("data-caelo-module-id=");
  expect(body).toContain(`<caelo-slot name="content">`);
});
