// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7 — Stage and Confirm publish from inside the overlay's top strip,
 * without leaving /edit. Drives an AI tool result to register a pending
 * change, then clicks Stage and verifies the staging deploy succeeded.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

const ts = Date.now();
const TPL_SLUG = `e2e-le-strip-tpl-${ts}`;
const MOD_SLUG = `e2e-le-strip-mod-${ts}`;
const PAGE_SLUG = `e2e-le-strip-page-${ts}`;
const PROVIDER = `live-edit-strip-${ts}`;
const BASE = "http://localhost:4173";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
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

test("Stage and Confirm publish strip in the overlay", async ({ context, page }) => {
  // Seed the page so we know the moduleId for the fixture's tool call.
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
          VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '')
          RETURNING id::text AS id\`;
        out.tpl = tpl[0].id;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${out.tpl}::uuid, 'content', 'Content', 0)\`;
        const mod = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'le mod', '<h1>STRIP_BEFORE</h1>')
          RETURNING id::text AS id\`;
        out.mod = mod[0].id;
        const pg = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'en', 'LE Strip Page', \${out.tpl}::uuid, 'published')
          RETURNING id::text AS id\`;
        out.pg = pg[0].id;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${out.pg}::uuid, 'content', 0, \${out.mod}::uuid)\`;
      });
      await sql.end();
      process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, TPL_SLUG, MOD_SLUG, PAGE_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const ids = JSON.parse(r.stdout) as { tpl: string; mod: string; pg: string };

  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        // Unique id per run — see note in live-edit-overlay.browser.ts.
        id: `tu_strip_${ts}`,
        name: "edit_module",
        arguments: { moduleId: ids.mod, html: "<h1>STRIP_AFTER</h1>" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Updated." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto(`/edit?page=${ids.pg}`);
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });

  const previewFrame = page.frameLocator("iframe[title='Live preview']");
  await expect(previewFrame.locator("h1")).toContainText("STRIP_BEFORE", { timeout: 15_000 });

  // Drive an AI edit so pendingChanges > 0 and Stage enables.
  await page.locator("textarea").fill("change the hero");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(previewFrame.locator("h1")).toContainText("STRIP_AFTER", { timeout: 15_000 });

  // P6.7.4 — Stage / Confirm-publish moved out of the overlay into the
  // toolbar header. Pending pill shows "1 pending change"; Stage button
  // enables; clicking it swaps the strip to the Confirm-publish state.
  const toolbarPublish = page.locator('[data-testid="toolbar-publish"]');
  await expect(toolbarPublish.locator('[data-testid="pending-pill"]')).toContainText(
    /pending change/i,
    { timeout: 5_000 },
  );
  const stageBtn = toolbarPublish.locator('[data-testid="stage-btn"]');
  await expect(stageBtn).toBeEnabled({ timeout: 5_000 });
  await stageBtn.click();
  const confirmBtn = page.locator('[data-testid="confirm-publish-btn"]');
  await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
});
