// SPDX-License-Identifier: MPL-2.0

/**
 * Regression for the live-edit-modifier-click CI flake (PR #717): with the
 * cross-chat banner ("Also pending: …") shown above the /edit toolbar, the
 * default pinned-right chat column — placed at a hard-coded `top: 56px` —
 * covered the toolbar's right-hand controls (then the "Edit elements"
 * toggle, removed in #916) so they could not be clicked. Parallel specs leave pending chats behind, so the
 * banner appeared at random and the click timed out.
 *
 * Here the banner is made deterministic: a chat of this spec's own Owner
 * gets a pending AI edit, then /edit opens a SECOND chat on the page. The
 * toolbar must stay clear of the column and its controls must take clicks.
 */

import { spawnSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  referenceViaContextMenu,
  registerTestProvider,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

// Its own Owner: the chats and the overlay layout (default pinned-right)
// are this spec's alone.
const OWNER_EMAIL = "banner-toolbar-e2e-owner@example.com";
const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const ts = Date.now();
const TPL_SLUG = `e2e-bt-tpl-${ts}`;
const MOD_SLUG = `e2e-bt-mod-${ts}`;
const PAGE_SLUG = `e2e-bt-page-${ts}`;
const PROVIDER = `banner-toolbar-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
});

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

async function newChat(page: Page): Promise<string> {
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  return page.url().split("/").pop() ?? "";
}

test("the pinned chat column never covers the toolbar while the cross-chat banner shows", async ({
  context,
  page,
}) => {
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
          VALUES (\${process.env.TPL_SLUG}, 'bt', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
          RETURNING id::text AS id\`;
        await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
        const mod = await tx\`
          INSERT INTO modules (slug, display_name, type, html, fields)
          VALUES (\${process.env.MOD_SLUG}, 'bt mod', \${process.env.MOD_SLUG}, '<h1>BANNER_TOOLBAR</h1>', '[{"name":"hero","kind":"text","label":"Hero","default":"BANNER_TOOLBAR"}]'::jsonb)
          RETURNING id::text AS id\`;
        out.mod = mod[0].id;
        const pg = await tx\`
          INSERT INTO pages (slug, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'BT Page', \${tpl[0].id}::uuid, 'draft')
          RETURNING id::text AS id\`;
        out.pg = pg[0].id;
        const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${out.mod}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pg}::uuid, 'content', 0, \${out.mod}::uuid, \${ci[0].id}::uuid)\`;
      });
      await sql.end();
      process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, TPL_SLUG, MOD_SLUG, PAGE_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const ids = JSON.parse(r.stdout) as { mod: string; pg: string };

  // One AI edit in the first chat leaves it with a pending change.
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_bt_${ts}`,
        name: "edit_module",
        arguments: { moduleId: ids.mod, html: "<h1>BANNER_TOOLBAR_EDITED</h1>" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Edited the hero." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await newChat(page);
  await page.getByTestId("chat-composer").fill("Change the hero");
  await page.getByTestId("chat-send").click();
  await expect(page.getByText("Edited the hero.")).toBeVisible({ timeout: 20_000 });

  // A second chat on the page: the first one is now "another open chat
  // with pending changes", so the banner shows above the toolbar.
  const second = await newChat(page);
  await page.goto(`/edit?page=${ids.pg}&chat=${second}`);
  await expect(page.getByText("Also pending:")).toBeVisible({ timeout: 15_000 });

  const toolbar = page.getByTestId("edit-toolbar");
  const column = page.getByRole("toolbar", { name: "Live-edit overlay controls" });
  await expect(column).toBeVisible();
  // The column starts below the toolbar, not on top of it. Polled: the
  // banner pushes the toolbar down first and the column follows on the
  // next layout pass (its top is derived from the measured chrome height),
  // so a single measurement can land between the two under load.
  await expect
    .poll(async () => {
      const toolbarBox = await toolbar.boundingBox();
      const columnBox = await column.boundingBox();
      if (!toolbarBox || !columnBox) return Number.NEGATIVE_INFINITY;
      return columnBox.y - (toolbarBox.y + toolbarBox.height);
    })
    .toBeGreaterThanOrEqual(0);

  // And the toolbar's right-hand controls take clicks: a trial click fails
  // when another element (the column) would receive it instead.
  await toolbar.getByRole("button", { name: /diff/i }).click({ trial: true });

  // Referencing an element from the preview still lands a chip.
  const h1 = page.frameLocator("iframe[title='Live preview']").locator("h1[data-caelo-module-id]");
  await referenceViaContextMenu(page, h1);
});
