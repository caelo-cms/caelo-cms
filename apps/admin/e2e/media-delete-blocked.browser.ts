// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — soft-delete is blocked when usage_count > 0; force=true is
 * required. Seeds an asset + a referencing module via raw SQL, then
 * drives the detail-page delete dialog to verify the referencing-
 * modules list surfaces and that confirming with force succeeds.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const SHA = `dead${"e".repeat(58)}${(ts % 100).toString().padStart(2, "0")}`.slice(0, 64);
const MOD_SLUG = `p7-delete-blocked-${ts}`;
const ALT = `p7-delete-blocked-${ts}`;
const BASE = "http://localhost:4173";

test.beforeAll(() => {
  clearLoginRateBucket();
  // Seed the asset + a module referencing it.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe("SET LOCAL caelo.actor_id = '00000000-0000-0000-0000-00000000ffff'");
      const inserted = await tx\`
        INSERT INTO media_assets (sha256, original_name, mime, size_bytes, alt, storage_key, usage_count, created_by)
        VALUES (\${process.env.SHA}, 'delete-blocked.jpg', 'image/jpeg', 1, \${process.env.ALT}, \${process.env.SHA + '/orig.jpg'}, 1, '00000000-0000-0000-0000-00000000ffff')
        RETURNING id::text AS id
      \`;
      const assetId = inserted[0].id;
      await tx\`
        INSERT INTO modules (slug, display_name, html, css, js)
        VALUES (\${process.env.MOD_SLUG}, 'p7 delete blocked', \${'<img src="/_caelo/media/' + assetId + '/orig" alt="x" />'}, '', '')
      \`;
      console.log(assetId);
    });
    await sql.end();
    `,
    { SHA, ALT, MOD_SLUG },
  );
});

test.afterAll(() => {
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
    { SHA, MOD_SLUG },
  );
});

test("delete dialog surfaces referencing modules and force=true succeeds", async ({ page }) => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "dev-owner@example.com");
  await page.fill('input[name="password"]', "dev-owner-password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`);

  // Find the asset by alt-text from the media list.
  await page.goto(`${BASE}/content/media?q=${encodeURIComponent(ALT)}`);
  const tile = page.getByText("delete-blocked.jpg").first();
  await expect(tile).toBeVisible();
  await tile.click();
  await page.waitForURL(/\/content\/media\/[0-9a-f-]{36}$/);

  // Used-in panel shows the referencing module.
  await expect(page.getByText("Used in")).toBeVisible();
  await expect(page.getByText(MOD_SLUG)).toBeVisible();

  // Open delete dialog → verify the count + force-flag wording.
  await page.getByRole("button", { name: /Delete asset/ }).click();
  await expect(page.getByText(/referenced from 1 module/)).toBeVisible();

  // Confirm — the page-server.ts injects force=true automatically when
  // referencingModules.length > 0 in the dialog.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForURL(/\/content\/media$/);
});
