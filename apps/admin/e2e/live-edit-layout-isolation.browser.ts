// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — proves multi-layout isolation: a footer attached to the
 * `site-default` layout reaches every page on every template bound to
 * site-default, but pages on a `bare`-layout template stay chrome-less.
 *
 * Setup mutates the DB directly (system actor) instead of routing
 * through the AI: creates a bare-layout template, a page using it, and
 * a footer module attached to site-default. Both pages render via the
 * preview endpoint; we assert the footer text appears only on the
 * site-default page.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

const ts = Date.now();
const BARE_TEMPLATE_SLUG = `bare-test-${ts}`;
const BARE_PAGE_SLUG = `bare-page-${ts}`;
const BARE_MODULE_SLUG = `bare-body-${ts}`;
const SITE_FOOTER_SLUG = `site-footer-${ts}`;
const FOOTER_TEXT = `LAYOUT_FOOTER_${ts}`;
const BARE_BODY_TEXT = `BARE_BODY_${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
  // Seed: bare-layout template + page; footer module on site-default.
  // All values flow via process.env so Bun's SQL tagged templates bind
  // them as parameters, not splice them into the script source.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    const TPL_SLUG = process.env.BARE_TEMPLATE_SLUG;
    const PAGE_SLUG = process.env.BARE_PAGE_SLUG;
    const MOD_SLUG = process.env.BARE_MODULE_SLUG;
    const FOOTER_SLUG = process.env.SITE_FOOTER_SLUG;
    const FOOTER_HTML = "<p>" + process.env.FOOTER_TEXT + "</p>";
    const BODY_HTML = "<p>" + process.env.BARE_BODY_TEXT + "</p>";
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const bareLayout = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug = 'bare'\`)[0])?.id;
      const siteDefault = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug = 'site-default'\`)[0])?.id;
      if (!bareLayout || !siteDefault) throw new Error("seed layouts missing");

      const tpl = ((await tx\`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (\${TPL_SLUG}, 'Bare Test',
                '<body><caelo-slot name="content">_</caelo-slot></body>',
                \${bareLayout}::uuid)
        RETURNING id::text AS id
      \`)[0])?.id;
      await tx\`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (\${tpl}::uuid, 'content', 'Content', 0)
      \`;
      const mod = ((await tx\`
        INSERT INTO modules (slug, display_name, html)
        VALUES (\${MOD_SLUG}, 'Bare body', \${BODY_HTML})
        RETURNING id::text AS id
      \`)[0])?.id;
      const pg = ((await tx\`
        INSERT INTO pages (slug, locale, name, title, template_id, status)
        VALUES (\${PAGE_SLUG}, 'en', 'Bare', 'Bare', \${tpl}::uuid, 'draft')
        RETURNING id::text AS id
      \`)[0])?.id;
      await tx\`
        INSERT INTO page_modules (page_id, block_name, position, module_id)
        VALUES (\${pg}::uuid, 'content', 0, \${mod}::uuid)
      \`;

      const footer = ((await tx\`
        INSERT INTO modules (slug, display_name, html)
        VALUES (\${FOOTER_SLUG}, 'Site Footer', \${FOOTER_HTML})
        RETURNING id::text AS id
      \`)[0])?.id;
      await tx\`
        INSERT INTO layout_modules (layout_id, block_name, position, module_id)
        VALUES (\${siteDefault}::uuid, 'footer', 0, \${footer}::uuid)
      \`;
    });
    await c.end();
    `,
    {
      BARE_TEMPLATE_SLUG,
      BARE_PAGE_SLUG,
      BARE_MODULE_SLUG,
      SITE_FOOTER_SLUG,
      FOOTER_TEXT,
      BARE_BODY_TEXT,
    },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    const TPL_SLUG = process.env.BARE_TEMPLATE_SLUG;
    const PAGE_SLUG = process.env.BARE_PAGE_SLUG;
    const MOD_SLUG = process.env.BARE_MODULE_SLUG;
    const FOOTER_SLUG = process.env.SITE_FOOTER_SLUG;
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const siteDefault = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug = 'site-default'\`)[0])?.id;
      if (siteDefault) {
        await tx\`
          DELETE FROM layout_modules
          WHERE layout_id = \${siteDefault}::uuid AND block_name = 'footer'
        \`;
      }
      await tx\`
        DELETE FROM page_modules WHERE page_id IN (
          SELECT id FROM pages WHERE slug = \${PAGE_SLUG}
        )
      \`;
      await tx\`DELETE FROM pages WHERE slug = \${PAGE_SLUG}\`;
      await tx\`
        DELETE FROM template_blocks WHERE template_id IN (
          SELECT id FROM templates WHERE slug = \${TPL_SLUG}
        )
      \`;
      await tx\`DELETE FROM templates WHERE slug = \${TPL_SLUG}\`;
      await tx\`DELETE FROM modules WHERE slug = \${MOD_SLUG} OR slug = \${FOOTER_SLUG}\`;
    });
    await c.end();
    `,
    {
      BARE_TEMPLATE_SLUG,
      BARE_PAGE_SLUG,
      BARE_MODULE_SLUG,
      SITE_FOOTER_SLUG,
    },
  );
});

test("site-default footer reaches home; bare-layout pages stay chrome-less", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // 1. The seeded home page (site-default) carries the new footer.
  const homeRes = await page.request.get("/edit/preview-by-path/en/home");
  expect(homeRes.status()).toBe(200);
  const homeHtml = await homeRes.text();
  expect(homeHtml).toContain(FOOTER_TEXT);
  expect(homeHtml).toContain('class="caelo-layout-footer"');

  // 2. The bare-layout page does NOT — it has no header/footer chrome.
  const bareRes = await page.request.get(`/edit/preview-by-path/en/${BARE_PAGE_SLUG}`);
  expect(bareRes.status()).toBe(200);
  const bareHtml = await bareRes.text();
  expect(bareHtml).not.toContain(FOOTER_TEXT);
  expect(bareHtml).not.toContain('class="caelo-layout-footer"');
  expect(bareHtml).toContain(BARE_BODY_TEXT);
});
