// SPDX-License-Identifier: MPL-2.0

/**
 * P6 verification — the thin end-to-end MVP:
 *   - Owner logs in, creates a template + module + page
 *   - Clicks Publish on the page (editor view: Draft → Live)
 *   - Static-gen runs synchronously, dist files land on disk
 *   - Re-loading the dist file from disk matches the composed output
 *
 * Publish here is the editor's single-button surface — Ops users get the
 * three-environment Draft → Staging → Production at /security/deployments
 * (covered by publish-ops.browser.ts).
 *
 * The webServer (vite preview build under Bun) runs from `apps/admin/`,
 * so the deploy.trigger op resolves out_dir against that cwd; dist lands
 * at apps/admin/output/<env>.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const TPL_SLUG = `e2e-pub-tpl-${ts}`;
const MOD_SLUG = `e2e-pub-mod-${ts}`;
const PAGE_SLUG = `e2e-pub-page-${ts}`;

test.afterEach(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
});

test("editor Publish button → static dist updated", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Template with one slot.
  await page.goto("/content/templates");
  await page.getByLabel("Slug").fill(TPL_SLUG);
  await page.getByLabel("Display name").fill("E2E Pub Tpl");
  await page
    .getByLabel(/HTML/)
    .fill(`<html><body><caelo-slot name="content">_</caelo-slot></body></html>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/templates\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByRole("button", { name: /save blocks/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // Module with the body the dist should contain.
  const uniqueText = `HELLO_${ts}`;
  await page.goto("/content/modules");
  await page.getByLabel("Slug").fill(MOD_SLUG);
  await page.getByLabel("Display name").fill("E2E Pub Mod");
  await page.getByLabel("HTML").fill(`<p>${uniqueText}</p>`);
  await page.getByRole("button", { name: /create/i }).click();
  await expect(page).toHaveURL(/\/content\/modules\/[0-9a-f-]+$/, { timeout: 15_000 });
  const moduleId = page.url().split("/").at(-1) ?? "";

  // Page that uses the module.
  await page.goto("/content/pages");
  await page.getByLabel("Slug").fill(PAGE_SLUG);
  await page.getByLabel("Locale").fill("en");
  await page.getByLabel("Title").fill("E2E About");
  const tplOpt = page
    .locator('select[name="templateId"] option')
    .filter({ hasText: TPL_SLUG })
    .first();
  const tplValue = (await tplOpt.getAttribute("value")) ?? "";
  expect(tplValue).not.toBe("");
  await page.locator('select[name="templateId"]').selectOption(tplValue);
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page).toHaveURL(/\/content\/pages\/[0-9a-f-]+$/, { timeout: 15_000 });
  const pageId = page.url().split("/").at(-1) ?? "";
  expect(pageId).toMatch(/^[0-9a-f-]{36}$/);
  // Add the module to the page's content slot via the block's "Add module"
  // dropdown (inside the <fieldset> for the block).
  const contentBlock = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "content" }) });
  await contentBlock.locator("select").selectOption(moduleId);
  await page.getByRole("button", { name: /^save layout$/i }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });

  // P6.2 #3 — editor publish is now Stage → Confirm. Stage runs the
  // staging build and surfaces a preview URL; Confirm promotes to prod.
  // P6.5 — pages list is a <table>, so rows are <tr>.
  await page.goto("/content/pages");
  const row = page.locator("tr").filter({ hasText: PAGE_SLUG });
  await row.getByRole("button", { name: /^stage$/i }).click();
  await expect(page.getByText(/Staged —/)).toBeVisible({ timeout: 15_000 });
  const stagedRow = page.locator("tr").filter({ hasText: PAGE_SLUG });
  await stagedRow.getByRole("button", { name: /^confirm publish$/i }).click();
  await expect(page.getByText(/Published to production/)).toBeVisible({ timeout: 15_000 });

  // P6.2 #2 — files live under output/<env>/current/ (the symlink).
  const distDir = resolve(process.cwd(), "output/production/current");
  const pageFile = resolve(distDir, PAGE_SLUG, "index.html");
  expect(existsSync(pageFile)).toBe(true);
  const html = readFileSync(pageFile, "utf8");
  expect(html).toContain(`<p>${uniqueText}</p>`);

  // robots.txt for production allows crawlers.
  const robots = readFileSync(resolve(distDir, "robots.txt"), "utf8");
  expect(robots).toContain("Allow: /");
});
