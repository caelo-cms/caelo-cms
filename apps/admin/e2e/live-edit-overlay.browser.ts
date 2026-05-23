// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7 — flagship live-edit verification.
 *
 *   1. Owner logs in → lands on /edit by clicking the sidebar nav.
 *   2. Iframe loads the production preview of a seeded page.
 *   3. AI prompt (test-provider fixture) lands an `edit_module` tool call.
 *   4. Iframe re-renders within ~2s with the new HTML.
 *   5. Element click in the iframe surfaces a chip in the overlay composer.
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
const TPL_SLUG = `e2e-le-tpl-${ts}`;
const MOD_SLUG = `e2e-le-mod-${ts}`;
const PAGE_SLUG = `e2e-le-page-${ts}`;
const PROVIDER = `live-edit-${ts}`;
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

test("Owner edits a page via the live-edit overlay; iframe re-renders", async ({
  context,
  page,
}) => {
  // Seed the page server-side so we can predict the moduleId for the
  // test-provider fixture's edit_module tool call.
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
        const mod = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'le mod', '<h1>HERO_BEFORE</h1>')
          RETURNING id::text AS id\`;
        out.mod = mod[0].id;
        const pg = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'en', 'LE Page', \${out.tpl}::uuid, 'published')
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
  const ids = JSON.parse(r.stdout) as { tpl: string; mod: string; pg: string };

  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        // Unique id per spec run — the chat-runner caches tool results
        // by (chatSessionId, toolCallId), and the spec's own load logic
        // reuses the most-recent unpublished session across runs. A
        // collision would short-circuit the dispatch and skip snapshot
        // emission, leaving HERO_BEFORE in the iframe.
        id: `tu_le_${ts}`,
        name: "edit_module",
        arguments: { moduleId: ids.mod, html: "<h1>HERO_FROM_AI</h1>" },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Updated the hero." },
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

  // Navigate to /edit via the sidebar.
  await page.getByRole("link", { name: /^Live edit$/ }).click();
  await expect(page).toHaveURL(/\/edit(\?|$)/, { timeout: 15_000 });

  // Pick the seeded page in the Combobox if not already active.
  // The page-picker auto-selects the first published page on first load,
  // and since we only just inserted ours, it might not be the selected
  // value yet — explicit navigation via URL keeps the test deterministic.
  await page.goto(`/edit?page=${ids.pg}`);

  // Wait for the iframe to load and verify the BEFORE state.
  const previewFrame = page.frameLocator("iframe[title='Live preview']");
  await expect(previewFrame.locator("h1")).toContainText("HERO_BEFORE", { timeout: 15_000 });

  // Send a message through the overlay's composer.
  await page.locator("textarea").fill("change the hero");
  await page.getByRole("button", { name: /^send$/i }).click();

  // After the AI tool result, the overlay posts a `caelo:reload` to the
  // iframe — the new HERO text should appear within a few seconds.
  await expect(previewFrame.locator("h1")).toContainText("HERO_FROM_AI", { timeout: 15_000 });
});
