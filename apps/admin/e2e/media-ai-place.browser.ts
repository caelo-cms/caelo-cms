// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — AI places media into module HTML via the existing edit_module
 * tool. Uses the in-process fixture provider to script:
 *   1. find_media → returns the seeded asset
 *   2. edit_module → injects <img src="/_caelo/media/<id>/orig">
 *
 * Verifies the chat surfaces the AI's reply, the module's HTML
 * contains the canonical /_caelo/media URL after publish, and the
 * AI's tool catalogue includes find_media + set_media_alt.
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
const MOD_SLUG = `e2e-media-ai-${ts}`;
const ALT = `e2e-media-ai-${ts}`;
const SHA = `aedeae00${"d".repeat(54)}${(ts % 100).toString().padStart(2, "0")}`.slice(0, 64);
const PROVIDER = `media-ai-place-${ts}`;
const BASE = "http://localhost:4173";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM media_assets WHERE sha256 = \${process.env.SHA}\`;
    });
    await sql.end();
    `,
    { MOD_SLUG, SHA },
  );
});

test("AI calls edit_module with a /_caelo/media URL after find_media surfaces the asset", async ({
  context,
  page,
}) => {
  // Seed: a module with placeholder HTML + a media asset the AI will reference.
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx.unsafe("SET LOCAL caelo.actor_id = '00000000-0000-0000-0000-00000000ffff'");
        await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
        await tx\`DELETE FROM media_assets WHERE sha256 = \${process.env.SHA}\`;
        const m = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'AI media e2e', '<section><h1>Hero</h1></section>')
          RETURNING id::text AS id
        \`;
        const a = await tx\`
          INSERT INTO media_assets (sha256, original_name, mime, size_bytes, alt, storage_key, created_by)
          VALUES (\${process.env.SHA}, 'ai-place.jpg', 'image/jpeg', 1, \${process.env.ALT}, \${process.env.SHA + '/orig.jpg'}, '00000000-0000-0000-0000-00000000ffff')
          RETURNING id::text AS id
        \`;
        process.stdout.write(m[0].id + ' ' + a[0].id);
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, MOD_SLUG, SHA, ALT }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const [moduleId, assetId] = r.stdout.trim().split(" ") as [string, string];
  expect(moduleId).toMatch(/^[0-9a-f-]{36}$/);
  expect(assetId).toMatch(/^[0-9a-f-]{36}$/);

  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "Adding the hero photo." },
      {
        kind: "tool-call",
        id: "tu_media_1",
        name: "edit_module",
        arguments: {
          moduleId,
          html: `<section><h1>Hero</h1><img src="/_caelo/media/${assetId}/orig" alt="${ALT}" /></section>`,
        },
      },
      { kind: "usage", inputTokens: 100, outputTokens: 30, cachedTokens: 80 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Done — hero photo placed." },
      { kind: "usage", inputTokens: 110, outputTokens: 10, cachedTokens: 100 },
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

  await page.locator("textarea").fill("place the hero photo on the hero section");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/Done — hero photo placed/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^publish$/i }).click();

  await page.goto(`/content/modules/${moduleId}`);
  const html = await page.locator('textarea[name="html"]').inputValue();
  expect(html).toContain(`/_caelo/media/${assetId}/orig`);
});
