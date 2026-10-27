// SPDX-License-Identifier: MPL-2.0

/**
 * #1156 — page SEO is draft state, and the editor shows it: the info
 * button in the preview's top corner opens the page's title, meta
 * description and social-share values. An SEO change the chat made is
 * marked Pending (button dot, badge per field) while the live row keeps
 * the old value until a Stage.
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
const OWNER_EMAIL = "e2e-page-seo-info-owner@example.com";
const TPL_SLUG = `e2e-seo-info-tpl-${ts}`;
const PAGE_SLUG = `e2e-seo-info-page-${ts}`;

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

/** Seed a page with a live meta description; returns its id. */
function seedPage(): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let pageId = "";
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'seo info', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'SEO Info Page', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      pageId = pg[0].id;
      await tx\`INSERT INTO pages_seo (page_id, meta_description) VALUES (\${pageId}::uuid, 'LIVE_DESCRIPTION')\`;
    });
    await sql.end();
    process.stdout.write(pageId);
    `,
    { TPL_SLUG, PAGE_SLUG },
  ).trim();
}

/** The chat's SEO write, exactly as the AI's set_page_seo makes it. */
function setSeoInChat(chatSessionId: string, pageId: string, metaDescription: string): void {
  runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const s = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx\`SELECT created_by::text AS actor, chat_branch_id::text AS branch FROM chat_sessions WHERE id = \${process.env.CHAT}::uuid\`)[0];
    });
    await db.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const r = await execute(registry, adapter, {
      actorId: s.actor, actorKind: "ai", requestId: "e2e-seo-info",
      chatBranchId: s.branch, chatTaskId: process.env.CHAT,
    }, "pages_seo.set", { pageId: process.env.PAGE, metaDescription: process.env.DESC });
    await adapter.close();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    `,
    { CHAT: chatSessionId, PAGE: pageId, DESC: metaDescription },
  );
}

function liveDescription(pageId: string): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const d = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx\`SELECT meta_description AS d FROM pages_seo WHERE page_id = \${process.env.PAGE}::uuid\`)[0]?.d ?? "";
    });
    await sql.end();
    process.stdout.write(d);
    `,
    { PAGE: pageId },
  );
}

test("the SEO info shows the page's SEO and marks the chat's pending change", async ({ page }) => {
  const pageId = seedPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  chatId = openOwnerChat(`e2e-seo-info-${ts}`, undefined, OWNER_EMAIL);
  await page.goto(`/edit?page=${pageId}&chat=${chatId}`);

  // Untouched: the live values, nothing pending.
  const info = page.getByTestId("page-seo-info");
  await expect(info).toHaveAttribute("data-pending", "false", { timeout: 15_000 });
  await info.click();
  const sheet = page.getByTestId("page-seo-sheet");
  await expect(sheet).toContainText("SEO Info Page");
  await expect(sheet).toContainText("LIVE_DESCRIPTION");
  await expect(sheet.getByTestId("page-seo-pending")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The chat rewrites the description: pending in the editor, not live.
  setSeoInChat(chatId, pageId, "DRAFT_DESCRIPTION");
  await page.reload();
  await expect(info).toHaveAttribute("data-pending", "true", { timeout: 15_000 });
  await info.click();
  await expect(sheet).toContainText("DRAFT_DESCRIPTION");
  await expect(sheet.getByTestId("page-seo-pending-note")).toContainText("next Stage");
  const description = sheet.locator('[data-testid="page-seo-row"][data-field="metaDescription"]');
  await expect(description.first().getByTestId("page-seo-pending")).toBeVisible();
  const title = sheet.locator('[data-testid="page-seo-row"][data-field="title"]');
  await expect(title.first().getByTestId("page-seo-pending")).toHaveCount(0);
  expect(liveDescription(pageId)).toBe("LIVE_DESCRIPTION");
});
