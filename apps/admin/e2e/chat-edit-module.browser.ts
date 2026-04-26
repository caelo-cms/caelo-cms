// SPDX-License-Identifier: MPL-2.0

/**
 * P5 verification flow against the fixture-replay provider:
 *   - Owner creates a module
 *   - Opens /content/chat → New chat
 *   - Sends "edit hero blue"
 *   - Fixture provider returns a tool_use → edit_module call → end_turn
 *   - Pending-changes pill increments to 1
 *   - Owner clicks Publish
 *   - Live module HTML reflects the AI edit
 *
 * The fixture file is written to /tmp/caelo-ai-fixture.json (the path
 * Playwright's webServer config sets via CAELO_AI_FIXTURE), then
 * deleted after the test so other specs that don't expect a fixture
 * fall through to the live-adapter path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const FIXTURE_PATH = "/tmp/caelo-ai-fixture.json";
const ts = Date.now();
const MOD_SLUG = `e2e-ai-mod-${ts}`;

test.afterEach(() => {
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
});

test("AI chat edits a module via the fixture provider", async ({ page }) => {
  // Seed a module via SQL so we know the id to put in the fixture.
  let moduleId = "";
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

  // Read back the module id we just inserted.
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
  moduleId = r.stdout.trim();
  expect(moduleId).toMatch(/^[0-9a-f-]{36}$/);

  // Write a multi-loop fixture: tool_use + continuation.
  writeFileSync(
    FIXTURE_PATH,
    JSON.stringify([
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
    ]),
  );

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

  // Wait for the AI follow-up text and the publish pill to update.
  await expect(page.getByText(/Done — hero is now blue/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 pending change/i)).toBeVisible({ timeout: 15_000 });

  // Click Publish.
  await page.getByRole("button", { name: /^publish$/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Live module reflects the edit. The chat-branch snapshot landed at
  // tool-call time and publish merged it into main.
  await page.goto(`/content/modules/${moduleId}`);
  await expect(page.locator('textarea[name="html"]')).toHaveValue(
    `<h1 style="color:blue">Hero</h1>`,
  );

  // Cleanup the seed module.
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
