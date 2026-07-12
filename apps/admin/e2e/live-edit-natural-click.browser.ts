// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.2 — links inside the iframe navigate naturally without modifier.
 * Seeds two pages; the first contains an `<a href="/<slug2>">` link.
 * Click without modifier → iframe navigates → toolbar URL display
 * updates to reflect the new path.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const TPL_SLUG = `e2e-le-nav-tpl-${ts}`;
const MOD_A_SLUG = `e2e-le-nav-mod-a-${ts}`;
const MOD_B_SLUG = `e2e-le-nav-mod-b-${ts}`;
const PAGE_A_SLUG = `e2e-le-nav-a-${ts}`;
const PAGE_B_SLUG = `e2e-le-nav-b-${ts}`;

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (\${process.env.PAGE_A_SLUG}, \${process.env.PAGE_B_SLUG}))\`;
      await tx\`DELETE FROM pages WHERE slug IN (\${process.env.PAGE_A_SLUG}, \${process.env.PAGE_B_SLUG})\`;
      await tx\`DELETE FROM modules WHERE slug IN (\${process.env.MOD_A_SLUG}, \${process.env.MOD_B_SLUG})\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_A_SLUG, MOD_B_SLUG, PAGE_A_SLUG, PAGE_B_SLUG },
  );
});

test("link click without modifier navigates the iframe; URL display updates", async ({ page }) => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      const out = {};
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const tpl = await tx\`
          INSERT INTO templates (slug, display_name, html, css, layout_id)
          VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
          RETURNING id::text AS id\`;
        out.tpl = tpl[0].id;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${out.tpl}::uuid, 'content', 'Content', 0)\`;
        const modA = await tx\`
          INSERT INTO modules (slug, display_name, type, html)
          VALUES (\${process.env.MOD_A_SLUG}, 'A', \${process.env.MOD_A_SLUG}, '<div><h1>HOME_A</h1><a id="go" href="/' || \${process.env.PAGE_B_SLUG} || '">go to B</a></div>')
          RETURNING id::text AS id\`;
        const modB = await tx\`
          INSERT INTO modules (slug, display_name, type, html)
          VALUES (\${process.env.MOD_B_SLUG}, 'B', \${process.env.MOD_B_SLUG}, '<h1>PAGE_B_LANDED</h1>')
          RETURNING id::text AS id\`;
        const pgA = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_A_SLUG}, 'en', 'A', \${out.tpl}::uuid, 'draft')
          RETURNING id::text AS id\`;
        out.pgA = pgA[0].id;
        const pgB = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_B_SLUG}, 'en', 'B', \${out.tpl}::uuid, 'draft')
          RETURNING id::text AS id\`;
        out.pgB = pgB[0].id;
        const ciA = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${modA[0].id}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
        const ciB = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${modB[0].id}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pgA}::uuid, 'content', 0, \${modA[0].id}::uuid, \${ciA[0].id}::uuid)\`;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pgB}::uuid, 'content', 0, \${modB[0].id}::uuid, \${ciB[0].id}::uuid)\`;
      });
      await sql.end();
      process.stdout.write(JSON.stringify(out));
      `,
    ],
    {
      env: { ...process.env, TPL_SLUG, MOD_A_SLUG, MOD_B_SLUG, PAGE_A_SLUG, PAGE_B_SLUG },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const ids = JSON.parse(r.stdout) as { tpl: string; pgA: string; pgB: string };

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto(`/edit?page=${ids.pgA}`);
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });

  const previewFrame = page.frameLocator("iframe[title='Live preview']");
  await expect(previewFrame.locator("h1")).toContainText("HOME_A", { timeout: 15_000 });
  // URL display reflects page A's slug.
  await expect(page.locator('[data-testid="edit-url"]')).toContainText(PAGE_A_SLUG);

  // Click the link inside the iframe via JS dispatch — the floating
  // overlay would otherwise intercept the pointer and a positional
  // click would race with the overlay drag handler. The behaviour
  // we're verifying (the click navigates the iframe) is independent
  // of how the click is delivered, so a programmatic click is fine.
  await previewFrame.locator("#go").evaluate((el: HTMLElement) => el.click());

  // Iframe navigates to page B; URL display updates.
  await expect(previewFrame.locator("h1")).toContainText("PAGE_B_LANDED", { timeout: 15_000 });
  await expect(page.locator('[data-testid="edit-url"]')).toContainText(PAGE_B_SLUG, {
    timeout: 5_000,
  });
});
