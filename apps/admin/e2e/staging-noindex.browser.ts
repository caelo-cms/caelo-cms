// SPDX-License-Identifier: MPL-2.0

/**
 * P6.1 — staging vhost enforces `X-Robots-Tag: noindex, nofollow` at
 * the serving layer per CMS_REQUIREMENTS §16.5. Robots.txt body alone
 * is not enough — a misconfigured body could leak; the response header
 * is the load-bearing safety net.
 *
 * Production must NOT carry the noindex header so a positive control
 * proves the staging assertion is meaningful.
 *
 * Requires `docker compose up -d caddy-staging caddy-production`.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const TPL_SLUG = `e2e-noindex-tpl-${ts}`;
const MOD_SLUG = `e2e-noindex-mod-${ts}`;
const PAGE_SLUG = `e2e-noindex-page-${ts}`;
const STAGING_BASE = "http://localhost:8081";
const PRODUCTION_BASE = "http://localhost:8082";

test.afterAll(() => {
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

test("staging serves X-Robots-Tag: noindex; production does not", async ({ page, request }) => {
  // Seed a published page via SQL so we can deploy to staging without
  // going through the editor flow (which would also promote to prod).
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const tpl = await tx\`
          INSERT INTO templates (slug, display_name, html, css)
          VALUES (\${process.env.TPL_SLUG}, 'noindex', '<body><caelo-slot name="content">_</caelo-slot></body>', '')
          RETURNING id::text AS id\`;
        await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
        const mod = await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.MOD_SLUG}, 'noindex mod', '<p>NOINDEX_TEST</p>')
          RETURNING id::text AS id\`;
        const pg = await tx\`
          INSERT INTO pages (slug, locale, title, template_id, status)
          VALUES (\${process.env.PAGE_SLUG}, 'en', 'Noindex', \${tpl[0].id}::uuid, 'published')
          RETURNING id::text AS id\`;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${pg[0].id}::uuid, 'content', 0, \${mod[0].id}::uuid)\`;
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, TPL_SLUG, MOD_SLUG, PAGE_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);

  // Login + drive deploy directly via the Ops dashboard.
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/security/deployments");
  const stagingRow = page
    .locator("li")
    .filter({ has: page.locator("strong", { hasText: "staging" }) });
  await stagingRow.getByRole("button", { name: /^build staging$/i }).click();
  await expect(page.getByText(/staging.*succeeded/i).first()).toBeVisible({ timeout: 15_000 });

  // Promote so production also has the same content.
  await page.locator('select[name="fromTarget"]').selectOption("staging");
  await page.locator('select[name="toTarget"]').selectOption("production");
  await page.getByRole("button", { name: /^promote$/i }).click();
  await expect(page.getByText(/production.*succeeded/i).first()).toBeVisible({ timeout: 15_000 });

  // Staging must carry X-Robots-Tag: noindex,nofollow. Retry briefly to
  // let Docker's bind mount surface the new files to Caddy.
  let stagingHeader = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.get(`${STAGING_BASE}/${PAGE_SLUG}/`);
    if (res.ok()) {
      stagingHeader = res.headers()["x-robots-tag"] ?? "";
      if (stagingHeader.includes("noindex")) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(stagingHeader.toLowerCase()).toContain("noindex");

  // Production must NOT carry the noindex header.
  let productionHeader: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.get(`${PRODUCTION_BASE}/${PAGE_SLUG}/`);
    if (res.ok()) {
      productionHeader = res.headers()["x-robots-tag"];
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(productionHeader ?? "").not.toContain("noindex");
});
