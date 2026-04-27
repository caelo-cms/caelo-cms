// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7 — clicking an element inside the live-preview iframe surfaces a
 * chip in the overlay composer. The injected runtime captures the click,
 * postMessages caelo:element-clicked to the parent, /edit/+page.svelte
 * dispatches a window CustomEvent, and ChatPanel listens for it and
 * appends to its chip array.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

function runBunInlineCapture(script: string, env: Record<string, string>): string {
  const r = spawnSync("bun", ["-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout;
}

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const TPL_SLUG = `e2e-le-click-tpl-${ts}`;
const MOD_SLUG = `e2e-le-click-mod-${ts}`;
const PAGE_SLUG = `e2e-le-click-page-${ts}`;

test.afterAll(() => {
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

test("clicking an element in the live-preview iframe appends a chip", async ({ page }) => {
  // Seed a draft page with a module whose outermost element will gain a
  // data-caelo-module-id attribute via composePagePreview.
  const seed = runBunInlineCapture(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = {};
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css)
        VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '')
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, html)
        VALUES (\${process.env.MOD_SLUG}, 'le mod', '<h1>HERO_CLICK_TARGET</h1>')
        RETURNING id::text AS id\`;
      const pg = await tx\`
        INSERT INTO pages (slug, locale, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'en', 'LE Click Page', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      out.pg = pg[0].id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${out.pg}::uuid, 'content', 0, \${mod[0].id}::uuid)\`;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
  const ids = JSON.parse(seed) as { pg: string };

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Use the URL ?page param for deterministic page selection — the
  // toolbar's bits-ui Combobox doesn't expose role=combobox.
  await page.goto(`/edit?page=${ids.pg}`);
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });

  // P6.7.3 — toolbar toggle replaces the modifier combo. Flip Edit on
  // before clicking the iframe element.
  await page.locator('[data-testid="edit-mode-toggle"]').click();

  const previewFrame = page.frameLocator("iframe[title='Live preview']");
  const taggedH1 = previewFrame.locator("h1[data-caelo-module-id]");
  await expect(taggedH1).toContainText("HERO_CLICK_TARGET", { timeout: 15_000 });

  // Synthesize the click so we bypass the floating overlay's pointer
  // interception. With edit mode ON the inject-script's capture
  // listener treats every same-page click as a chip emit regardless of
  // modifier flags.
  await taggedH1.evaluate((el: HTMLElement) => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  const chip = page.locator('[data-testid="chip"]').first();
  await expect(chip).toBeVisible({ timeout: 5_000 });
});
