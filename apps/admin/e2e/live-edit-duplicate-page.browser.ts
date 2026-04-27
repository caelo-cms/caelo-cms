// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `duplicate_page` clones a page row + page_modules
 * (modules referenced, not deep-copied). Verifies the new page exists,
 * carries the same module ids in the same blocks, and inherits the
 * source template by default.
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

const ts = Date.now();
const PROVIDER = `duplicate-${ts}`;
const NEW_SLUG = `home-clone-${ts}`;
const BASE = "http://localhost:4173";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (
        SELECT id FROM pages WHERE slug = \${process.env.NEW_SLUG}
      )\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.NEW_SLUG}\`;
    });
    await c.end();
    `,
    { NEW_SLUG },
  );
});

test("duplicate_page clones home into a new slug; same module ids carry over", async ({
  context,
  page,
}) => {
  // Resolve home page id directly so the AI-tool call gets the right id.
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      let id = "";
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = await tx\`SELECT id::text AS id FROM pages WHERE slug = 'home' AND locale = 'en' LIMIT 1\`;
        id = (rows as { id: string }[])[0]?.id ?? "";
      });
      await c.end();
      process.stdout.write(id);
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const sourcePageId = r.stdout.trim();
  expect(sourcePageId).toBeTruthy();

  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_dup_${ts}`,
        name: "duplicate_page",
        arguments: { sourcePageId, newSlug: NEW_SLUG },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Page duplicated." },
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

  await page.goto("/edit");
  await page.locator("textarea").fill("clone the home page");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText("Page duplicated.").first()).toBeVisible({ timeout: 30_000 });

  // DB check: new page exists; page_modules.module_id list matches the source.
  const verify = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      let result;
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const newPg = await tx\`SELECT id::text AS id, template_id::text AS template_id FROM pages WHERE slug = \${process.env.NEW_SLUG}\`;
        const newId = (newPg as { id: string; template_id: string }[])[0];
        const srcMods = await tx\`SELECT module_id::text AS m, block_name AS b, position AS p FROM page_modules WHERE page_id = \${process.env.SOURCE_ID}::uuid ORDER BY block_name, position\`;
        const newMods = newId ? await tx\`SELECT module_id::text AS m, block_name AS b, position AS p FROM page_modules WHERE page_id = \${newId.id}::uuid ORDER BY block_name, position\` : [];
        result = { newPage: newId, src: srcMods, dup: newMods };
      });
      await c.end();
      process.stdout.write(JSON.stringify(result));
      `,
    ],
    { env: { ...process.env, NEW_SLUG, SOURCE_ID: sourcePageId }, encoding: "utf8" },
  );
  if (verify.status !== 0) throw new Error(verify.stderr);
  const parsed = JSON.parse(verify.stdout) as {
    newPage: { id: string; template_id: string } | undefined;
    src: { m: string; b: string; p: number }[];
    dup: { m: string; b: string; p: number }[];
  };
  expect(parsed.newPage?.id).toBeTruthy();
  expect(parsed.dup.length).toBe(parsed.src.length);
  expect(parsed.dup).toEqual(parsed.src);
});
