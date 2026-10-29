// SPDX-License-Identifier: MPL-2.0

/**
 * #1207 — the page search in the live editor's address bar. Its field
 * says what it does instead of showing the page's title; a click opens
 * it straight away with the pages changed last; typing finds any page
 * by path, and picking one opens it in the editor.
 */

import { expect, test } from "@playwright/test";
import {
  archiveChat,
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  openOwnerChat,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const ts = Date.now();
/** Own Owner: Live Edit resumes the owner's newest chat (see #1081). */
const OWNER_EMAIL = "e2e-page-search-owner@example.com";
const TPL_SLUG = `e2e-page-search-tpl-${ts}`;
const START_SLUG = `e2e-page-search-start-${ts}`;
const EDITED_SLUG = `e2e-page-search-edited-${ts}`;

let chatId: string | null = null;

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
});

test.afterAll(() => {
  if (chatId) archiveChat(chatId);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM pages WHERE slug IN (\${process.env.START_SLUG}, \${process.env.EDITED_SLUG})\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, START_SLUG, EDITED_SLUG },
  );
});

/**
 * Two pages; the second is then edited through `pages.update`, which
 * writes the snapshot the search's "Recently edited" reads. Returns the
 * start page's id.
 */
function seedPages(): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const ids = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'page search', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const start = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.START_SLUG}, 'Search Start', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      const edited = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.EDITED_SLUG}, 'Search Target', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      return { start: start[0].id, edited: edited[0].id };
    });
    await sql.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const r = await execute(registry, adapter, {
      actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-page-search",
    }, "pages.update", { pageId: ids.edited, title: "Search Target, edited" });
    await adapter.close();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    process.stdout.write(ids.start);
    `,
    { TPL_SLUG, START_SLUG, EDITED_SLUG },
  ).trim();
}

test("the page search opens on click with recent pages and switches to a found page", async ({
  page,
}) => {
  const startId = seedPages();

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  chatId = openOwnerChat(`e2e-page-search-${ts}`, undefined, OWNER_EMAIL);
  await page.goto(`/edit?page=${startId}&chat=${chatId}`);
  await expect(page.getByTestId("edit-url")).toHaveText(`/${START_SLUG}`);

  // The field names its job; the page's title is not in it.
  const input = page.getByTestId("page-search-input");
  await expect(input).toHaveAttribute("placeholder", "Search pages…");
  await expect(input).toHaveValue("");

  // One click opens the list, the edited page under "Recently edited".
  await input.click();
  const recent = page.locator('[data-testid="page-search-group"][data-heading="Recently edited"]');
  await expect(
    recent.getByTestId("page-search-item").filter({ hasText: EDITED_SLUG }),
  ).toBeVisible();

  // Typing finds a page by path; picking it opens it and clears the field.
  await input.fill(EDITED_SLUG);
  const items = page.getByTestId("page-search-item");
  await expect(items).toHaveCount(1);
  await items.first().click();
  await expect(page.getByTestId("edit-url")).toHaveText(`/${EDITED_SLUG}`);
  await expect(input).toHaveValue("");
});
