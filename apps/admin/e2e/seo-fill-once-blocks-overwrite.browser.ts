// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — pages_seo.autofill is fill-once. The seo-autofill skill calls
 * it on the first-publish path; a second call returns
 * AlreadyAutofilled and the SEO fields stay untouched.
 *
 * Drives the contract directly via the Query API (no chat round-trip
 * needed — the contract is op-layer, not skill-layer). Browser
 * provides the auth cookie + the admin API endpoint.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const PAGE_SLUG = `seo-fillonce-${ts}`;
const FIRST_DESC = `First-fill description ${ts}.`;
const SECOND_DESC = `Should not overwrite ${ts}.`;
const BASE = "http://localhost:4173";

test.beforeAll(() => {
  clearLoginRateBucket();
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
    });
    await sql.end();
    `,
    { PAGE_SLUG },
  );
});

test("autofill is fill-once; second call leaves SEO untouched", async ({ page }) => {
  // Seed a draft page directly so we know its id.
  const seed = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
        const tplRows = await tx\`SELECT id::text AS id FROM templates WHERE slug = 'home-template' LIMIT 1\`;
        const rows = await tx\`
          INSERT INTO pages (slug, locale, name, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'en', \${process.env.PAGE_SLUG}, \${process.env.PAGE_SLUG}, \${tplRows[0].id}::uuid, 'draft')
          RETURNING id::text AS id
        \`;
        process.stdout.write(rows[0].id);
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, PAGE_SLUG }, encoding: "utf8" },
  );
  if (seed.status !== 0) throw new Error(seed.stderr);
  const pageId = seed.stdout.trim();
  expect(pageId).toMatch(/^[0-9a-f-]{36}$/);

  // Login + bake the cookie.
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "dev-owner@example.com");
  await page.fill('input[name="password"]', "dev-owner-password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);

  // First autofill via the SEO panel form. The /content/pages/[id]/seo
  // panel only exposes pages_seo.set, not autofill — autofill is on
  // the AI-tool surface. Drive the op directly through a Bun helper
  // process that uses the system actor (mirrors how the seo-autofill
  // skill would call it after the AI assembles the metaDescription).
  const first = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, OperationRegistry, execute } from "@caelo/query-api";
      import { registerAdminOps } from "@caelo/admin-core";
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL,
      });
      const reg = new OperationRegistry();
      registerAdminOps(reg);
      const ctx = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e" };
      const r = await execute(reg, adapter, ctx, "pages_seo.autofill", {
        pageId: process.env.PAGE_ID,
        metaDescription: process.env.FIRST_DESC,
      });
      await adapter.close();
      process.stdout.write(JSON.stringify({ ok: r.ok, message: r.ok ? null : r.error?.message }));
      `,
    ],
    { env: { ...process.env, PAGE_ID: pageId, FIRST_DESC }, encoding: "utf8" },
  );
  if (first.status !== 0) throw new Error(first.stderr);
  const firstResult = JSON.parse(first.stdout) as { ok: boolean; message: string | null };
  expect(firstResult.ok).toBe(true);

  // Open the panel and confirm the meta description rendered.
  await page.goto(`${BASE}/content/pages/${pageId}/seo`);
  const desc = page.locator('textarea[name="metaDescription"]');
  await expect(desc).toHaveValue(FIRST_DESC);

  // Second autofill — must return AlreadyAutofilled.
  const second = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, OperationRegistry, execute } from "@caelo/query-api";
      import { registerAdminOps } from "@caelo/admin-core";
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL,
      });
      const reg = new OperationRegistry();
      registerAdminOps(reg);
      const ctx = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e" };
      const r = await execute(reg, adapter, ctx, "pages_seo.autofill", {
        pageId: process.env.PAGE_ID,
        metaDescription: process.env.SECOND_DESC,
      });
      await adapter.close();
      process.stdout.write(JSON.stringify({ ok: r.ok, message: r.ok ? null : r.error?.message }));
      `,
    ],
    { env: { ...process.env, PAGE_ID: pageId, SECOND_DESC }, encoding: "utf8" },
  );
  if (second.status !== 0) throw new Error(second.stderr);
  const secondResult = JSON.parse(second.stdout) as { ok: boolean; message: string | null };
  expect(secondResult.ok).toBe(false);
  expect(secondResult.message).toContain("AlreadyAutofilled");

  // Reload the panel — the description must be the FIRST one.
  await page.reload();
  await expect(page.locator('textarea[name="metaDescription"]')).toHaveValue(FIRST_DESC);
});
