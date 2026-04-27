// SPDX-License-Identifier: MPL-2.0

/**
 * P5 verification flow against the in-process test-provider registry
 * (P5.2 #1):
 *   - Owner creates a module
 *   - Opens /content/chat → New chat
 *   - Sends "edit hero blue"
 *   - Test provider returns a tool_use → edit_module call → end_turn
 *   - Pending-changes pill increments to 1
 *   - Owner clicks Publish
 *   - Live module HTML reflects the AI edit
 *
 * The fixture is registered at POST /__test/providers (in-memory; only
 * served when NODE_ENV !== production) and the spec's BrowserContext
 * sets `x-caelo-test-provider: <name>` on outbound chat-stream POSTs.
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
const MOD_SLUG = `e2e-ai-mod-${ts}`;
const PROVIDER = `chat-edit-module-${ts}`;
const BASE = "http://localhost:4173";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

test("AI chat edits a module via the in-memory test provider", async ({ context, page }) => {
  // Seed a module via SQL so we know the id to put in the fixture.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      const rows = await tx\`
        INSERT INTO modules (slug, display_name, html)
        VALUES (\${process.env.MOD_SLUG}, 'AI E2E Hero', '<h1>Hero</h1>')
        RETURNING id::text AS id
      \`;
      console.log(rows[0].id);
    });
    await sql.end();
    `,
    { MOD_SLUG },
  );

  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = await tx\`SELECT id::text AS id FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
        process.stdout.write(rows[0].id);
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, MOD_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const moduleId = r.stdout.trim();
  expect(moduleId).toMatch(/^[0-9a-f-]{36}$/);

  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Updating the hero." },
      {
        kind: "tool-call",
        id: "tu_e2e",
        name: "edit_module",
        arguments: { moduleId, html: '<h1 style="color:blue">Hero</h1>' },
      },
      { kind: "usage", inputTokens: 80, outputTokens: 25, cachedTokens: 60 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Done — hero is now blue." },
      { kind: "usage", inputTokens: 90, outputTokens: 10, cachedTokens: 80 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });

  await page.locator("textarea").fill("make hero blue");
  await page.getByRole("button", { name: /^send$/i }).click();

  await expect(page.getByText(/Done — hero is now blue/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 pending change/i)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /^publish$/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });

  await page.goto(`/content/modules/${moduleId}`);
  await expect(page.locator('textarea[name="html"]')).toHaveValue(
    `<h1 style="color:blue">Hero</h1>`,
  );

  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
    });
    await sql.end();
    `,
    { MOD_SLUG },
  );
});
