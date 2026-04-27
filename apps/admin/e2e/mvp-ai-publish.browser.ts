// SPDX-License-Identifier: MPL-2.0

/**
 * P6.1 — full MVP narrative in one Playwright run:
 *   1. Login as Owner
 *   2. Create template + page bound to that template
 *   3. AI edits the module via the in-memory test-provider
 *   4. Publish the chat (merge branch into main)
 *   5. Publish the page (editor button → staging gate → promote to production)
 *   6. GET the production-served URL via Caddy and assert the AI's edit is live
 *
 * This pins the master plan's verification line:
 *   "fresh install → login → AI edit → live preview → Publish (editor view: Draft → Live)"
 *
 * Requires `docker compose up -d caddy-staging caddy-production`.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const TPL_SLUG = `e2e-mvp-tpl-${ts}`;
const MOD_SLUG = `e2e-mvp-mod-${ts}`;
const PAGE_SLUG = `e2e-mvp-page-${ts}`;
const PROVIDER = `mvp-ai-publish-${ts}`;
const BASE = "http://localhost:4173";
const PRODUCTION_BASE = "http://localhost:8082";

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

test("AI edit → publish chat → publish page → served from Caddy", async ({
  context,
  page,
  request,
}) => {
  // Seed module + template + page directly via SQL so the test stays
  // focused on the AI-edit → publish → serve narrative.
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
          VALUES (\${process.env.TPL_SLUG}, 'mvp', '<body><caelo-slot name="content">_</caelo-slot></body>', '')
          RETURNING id::text AS id\`;
        out.tpl = tpl[0].id;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${out.tpl}::uuid, 'content', 'Content', 0)\`;
        const mod = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'mvp mod', '<p>HERO_BEFORE</p>')
          RETURNING id::text AS id\`;
        out.mod = mod[0].id;
        const pg = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'en', 'MVP Page', \${out.tpl}::uuid, 'draft')
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

  // Test-provider fixture: AI calls edit_module to set the new HTML.
  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: "tu_mvp",
        name: "edit_module",
        arguments: { moduleId: ids.mod, html: "<p>HERO_FROM_AI</p>" },
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

  // AI chat: send the edit, wait for the response, click Publish (chat publish).
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.locator("textarea").fill("set hero text");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Updated the hero/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 pending change/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^publish$/i }).click();

  // P6.2 #3 — Stage then Confirm publish. P6.5 — pages list is a table.
  await page.goto("/content/pages");
  const row = page.locator("tr").filter({ hasText: PAGE_SLUG });
  await row.getByRole("button", { name: /^stage$/i }).click();
  await expect(page.getByText(/Staged —/).first()).toBeVisible({ timeout: 30_000 });
  const stagedRow = page.locator("tr").filter({ hasText: PAGE_SLUG });
  await stagedRow.getByRole("button", { name: /^confirm publish$/i }).click();
  await expect(page.getByText(/Published to production/).first()).toBeVisible({ timeout: 15_000 });

  // Caddy on :8082 (production) now serves the page with the AI edit.
  // Retry briefly because the Caddy file mount picks up changes near-instantly
  // but kernel-cached file metadata can lag a beat on macOS Docker.
  let html = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.get(`${PRODUCTION_BASE}/${PAGE_SLUG}/`);
    if (res.ok()) {
      html = await res.text();
      if (html.includes("HERO_FROM_AI")) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(html).toContain("HERO_FROM_AI");
  expect(html).not.toContain("HERO_BEFORE");
});
