// SPDX-License-Identifier: MPL-2.0

/**
 * #1760 — the seo plugin's work, visible where the human approves it:
 *   1. The SEO overview panel lists a page with the title search engines
 *      get, where it comes from, and a link that opens it in the editor;
 *      the page type filter offers the site's page types.
 *   2. In the editor, the search and share preview next to the page address
 *      shows the page as a desktop and a phone result and as a shared link,
 *      from the values the chat's view resolves.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const TPL_SLUG = `e2e-seo-ov-tpl-${ts}`;
const PAGE_SLUG = `e2e-seo-ov-page-${ts}`;
const TITLE = `Pricing plans for teams ${ts}`;
const DESCRIPTION = "Plans and prices for every team size, billed monthly or yearly.";

let pageId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  clearLoginRateBucket();
  pageId = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let pageId = "";
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'seo overview', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status, page_type_confirmed)
        VALUES (\${process.env.PAGE_SLUG}, 'SEO overview page', \${tpl[0].id}::uuid, 'draft', true)
        RETURNING id::text AS id\`;
      pageId = pg[0].id;
      await tx\`INSERT INTO pages_seo (page_id, seo_title, meta_description, value_origins)
        VALUES (\${pageId}::uuid, \${process.env.TITLE}, \${process.env.DESCRIPTION},
                '{"seoTitle":"human","metaDescription":"human"}'::jsonb)\`;
    });
    await sql.end();
    process.stdout.write(pageId);
    `,
    { TPL_SLUG, PAGE_SLUG, TITLE, DESCRIPTION },
  ).trim();
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
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, PAGE_SLUG },
  );
});

async function signInAndActivate(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  await page.goto("/settings/plugins");
  const activate = page.getByTestId("activate-seo");
  if ((await activate.count()) > 0) {
    await activate.click();
    await expect(page.getByTestId("activate-seo")).toHaveCount(0, { timeout: 30_000 });
  }
}

test("the SEO overview lists the page with its title and origin, and links into the editor", async ({
  page,
}) => {
  await signInAndActivate(page);
  await page.goto(`/plugins/seo/overview?pages.origin=human`);
  await expect(page.getByRole("heading", { name: "SEO overview" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: PAGE_SLUG });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(TITLE);
  await expect(row).toContainText("human");
  // The page type filter lists the site's page types, from the plugin.
  const types = page.getByRole("navigation", { name: "Page type" });
  await expect(types.getByRole("link", { name: "All page types" })).toBeVisible();
  await expect(types.getByRole("link", { name: "Home page" })).toBeVisible();
  // The row opens the page in the editor.
  await row.getByTestId("panel-page-link").click();
  await expect(page).toHaveURL(new RegExp(`/edit\\?page=${pageId}`), { timeout: 15_000 });
});

test("the editor's search and share preview shows the page as a result and as a shared link", async ({
  page,
}) => {
  await signInAndActivate(page);
  await page.goto(`/edit?page=${pageId}`);
  const slot = page.locator('[data-testid="plugin-toolbar-slot"][data-slot="seo/search-preview"]');
  await expect(slot).toBeVisible({ timeout: 15_000 });
  await slot.click();
  const panel = page.locator(
    '[data-testid="plugin-toolbar-panel"][data-slot="seo/search-preview"]',
  );
  const desktop = panel.locator('[data-testid="toolbar-preview-search"][data-device="desktop"]');
  const phone = panel.locator('[data-testid="toolbar-preview-search"][data-device="mobile"]');
  await expect(desktop.getByTestId("toolbar-preview-title")).toContainText(
    "Pricing plans for teams",
  );
  await expect(desktop.getByTestId("toolbar-preview-description")).toHaveText(DESCRIPTION);
  await expect(desktop.getByTestId("toolbar-preview-url")).toContainText(PAGE_SLUG);
  await expect(phone).toBeVisible();
  const card = panel.getByTestId("toolbar-preview-social");
  await expect(card).toContainText(TITLE);
  // A prompt goes into the composer for the operator to send.
  await panel
    .getByTestId("plugin-toolbar-prompt")
    .filter({ hasText: "Improve title and text" })
    .click();
  await expect(page.getByTestId("chat-composer")).toHaveValue(
    new RegExp(`Improve the SEO title and meta description of /${PAGE_SLUG}`),
  );
});
