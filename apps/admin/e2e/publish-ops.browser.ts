// SPDX-License-Identifier: MPL-2.0

/**
 * P6 Ops verification — Owner with `ops.view` lands on
 * /security/deployments and drives the explicit dev/staging/production flow:
 *   - Build "staging" → output/staging populated, robots.txt blocks crawlers
 *   - Promote staging → production → output/production matches staging
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const TPL_SLUG = `e2e-ops-tpl-${ts}`;
const MOD_SLUG = `e2e-ops-mod-${ts}`;
const PAGE_SLUG = `e2e-ops-page-${ts}`;

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

test("Ops: build staging → promote to production", async ({ page }) => {
  // Seed published page directly so we don't depend on the editor flow.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'ops', '<body><caelo-slot name="main">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'bare'))
        RETURNING id::text AS id\`;
      const tplId = tpl[0].id;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tplId}::uuid, 'main', 'Main', 0)\`;
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, html)
        VALUES (\${process.env.MOD_SLUG}, 'ops mod', \${'<p>OPS_' + process.env.PAGE_SLUG + '</p>'})
        RETURNING id::text AS id\`;
      const modId = mod[0].id;
      const pg = await tx\`
        INSERT INTO pages (slug, locale, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'en', 'Ops Page', \${tplId}::uuid, 'published')
        RETURNING id::text AS id\`;
      const pgId = pg[0].id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${pgId}::uuid, 'main', 0, \${modId}::uuid)\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/security/deployments");
  await expect(page.getByRole("heading", { name: "Deployments" })).toBeVisible();

  // Build staging.
  const stagingForm = page
    .locator("li")
    .filter({ has: page.locator("strong", { hasText: "staging" }) });
  await stagingForm.getByRole("button", { name: /^build staging$/i }).click();

  await expect(page.getByText(/staging.*succeeded/i).first()).toBeVisible({ timeout: 15_000 });

  const stagingDir = resolve(process.cwd(), "output/staging/current");
  const stagingPage = resolve(stagingDir, PAGE_SLUG, "index.html");
  expect(existsSync(stagingPage)).toBe(true);
  expect(readFileSync(stagingPage, "utf8")).toContain(`OPS_${PAGE_SLUG}`);
  // Staging robots.txt blocks crawlers.
  expect(readFileSync(resolve(stagingDir, "robots.txt"), "utf8")).toContain("Disallow: /");

  // Promote staging → production.
  await page.locator('select[name="fromTarget"]').selectOption("staging");
  await page.locator('select[name="toTarget"]').selectOption("production");
  await page.getByRole("button", { name: /^promote$/i }).click();

  await expect(page.getByText(/production.*succeeded/i).first()).toBeVisible({ timeout: 15_000 });

  const productionPage = resolve(
    process.cwd(),
    "output/production/current",
    PAGE_SLUG,
    "index.html",
  );
  expect(existsSync(productionPage)).toBe(true);
  expect(readFileSync(productionPage, "utf8")).toContain(`OPS_${PAGE_SLUG}`);
});
