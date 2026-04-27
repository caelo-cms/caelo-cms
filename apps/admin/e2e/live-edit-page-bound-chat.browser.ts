// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.4 — chats are scoped to the active /edit page. Switching pages in
 * the Combobox switches to that page's most-recent chat (or creates one);
 * the history dropdown lists only chats bound to the current page.
 *
 * Strategy: seed two pages, land on each, and verify the active chat's
 * `chatBranchId` is different per page (a clean signal that the loader
 * is filtering rather than reusing a single shared chat).
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const TPL_SLUG = `e2e-pbc-tpl-${ts}`;
const MOD_A_SLUG = `e2e-pbc-mod-a-${ts}`;
const MOD_B_SLUG = `e2e-pbc-mod-b-${ts}`;
const PAGE_A_SLUG = `e2e-pbc-a-${ts}`;
const PAGE_B_SLUG = `e2e-pbc-b-${ts}`;

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // chat_sessions.page_id ON DELETE SET NULL — chats stay; the FK
      // unbinds. Wipe the auto-created Live-edit chats explicitly so
      // the dropdown for the dev-owner doesn't accumulate clutter.
      await tx\`DELETE FROM chat_sessions WHERE page_id IN (SELECT id FROM pages WHERE slug IN (\${process.env.PAGE_A_SLUG}, \${process.env.PAGE_B_SLUG}))\`;
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

test("chats are scoped per page; switching pages switches the active chat", async ({ page }) => {
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
          INSERT INTO templates (slug, display_name, html, css)
          VALUES (\${process.env.TPL_SLUG}, 'pbc', '<body><caelo-slot name="content">_</caelo-slot></body>', '')
          RETURNING id::text AS id\`;
        out.tpl = tpl[0].id;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${out.tpl}::uuid, 'content', 'Content', 0)\`;
        const modA = await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_A_SLUG}, 'A', '<h1>PAGE_A</h1>') RETURNING id::text AS id\`;
        const modB = await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_B_SLUG}, 'B', '<h1>PAGE_B</h1>') RETURNING id::text AS id\`;
        const pgA = await tx\`INSERT INTO pages (slug, locale, title, template_id, status) VALUES (\${process.env.PAGE_A_SLUG}, 'en', 'A', \${out.tpl}::uuid, 'draft') RETURNING id::text AS id\`;
        const pgB = await tx\`INSERT INTO pages (slug, locale, title, template_id, status) VALUES (\${process.env.PAGE_B_SLUG}, 'en', 'B', \${out.tpl}::uuid, 'draft') RETURNING id::text AS id\`;
        out.pgA = pgA[0].id;
        out.pgB = pgB[0].id;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${out.pgA}::uuid, 'content', 0, \${modA[0].id}::uuid)\`;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${out.pgB}::uuid, 'content', 0, \${modB[0].id}::uuid)\`;
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
  const ids = JSON.parse(r.stdout) as { pgA: string; pgB: string };

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Land on page A — loader auto-creates a fresh A-bound chat.
  await page.goto(`/edit?page=${ids.pgA}`);
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  // Read the active chat session id from SvelteKit's hydration data.
  const chatA = await page.evaluate(() => {
    const m = document.documentElement.outerHTML.match(/activeChat:\{id:"([^"]+)"/);
    return m?.[1] ?? null;
  });
  expect(chatA).toBeTruthy();

  // Switch to page B — loader auto-creates a fresh B-bound chat (or
  // picks an existing one that's bound to B).
  await page.goto(`/edit?page=${ids.pgB}`);
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  const chatB = await page.evaluate(() => {
    const m = document.documentElement.outerHTML.match(/activeChat:\{id:"([^"]+)"/);
    return m?.[1] ?? null;
  });
  expect(chatB).toBeTruthy();
  expect(chatB).not.toBe(chatA);

  // Coming back to page A returns A's chat (not B's).
  await page.goto(`/edit?page=${ids.pgA}`);
  const chatAAgain = await page.evaluate(() => {
    const m = document.documentElement.outerHTML.match(/activeChat:\{id:"([^"]+)"/);
    return m?.[1] ?? null;
  });
  expect(chatAAgain).toBe(chatA);
});
