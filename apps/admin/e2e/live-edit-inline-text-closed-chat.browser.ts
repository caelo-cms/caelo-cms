// SPDX-License-Identifier: MPL-2.0

/**
 * #1102 — an in-place save into a chat that was archived after Live Edit
 * loaded it (another tab, the chat list, an agent) is refused with what to
 * do next. Before the fix the save landed in the closed chat: "Saved.", but
 * the reload (which never resumes a closed chat) showed the old text. A
 * link to the closed chat now opens another one with a notice saying so.
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
const TPL_SLUG = `e2e-le-closed-tpl-${ts}`;
const MOD_SLUG = `e2e-le-closed-mod-${ts}`;
const PAGE_SLUG = `e2e-le-closed-page-${ts}`;
/**
 * Own Owner: after the closed chat, Live Edit falls back to the operator's
 * newest open chat, and the test then follows "Continue here" into it. As
 * the shared dev-owner, a parallel spec could close that fallback chat in
 * between, and the notice rightly came back for it.
 */
const OWNER_EMAIL = "e2e-le-closed-chat-owner@example.com";

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM content_instance_snapshots WHERE content_instance_id IN (SELECT id FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG}))\`;
      await tx\`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG})\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
});

test("a save into a chat archived after the load is refused, not lost", async ({ page }) => {
  const seed = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = {};
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT default_page_type_id FROM site_defaults WHERE id = 1) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const fields = JSON.stringify([{ name: "title", kind: "text", label: "Title" }]);
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${process.env.MOD_SLUG}, 'closed mod', \${process.env.MOD_SLUG}, '<section class="hero"><h1>{{title}}</h1></section>', \${fields}::text::jsonb)
        RETURNING id::text AS id\`;
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'LE Closed Page', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      out.pg = pg[0].id;
      const values = JSON.stringify({ title: "CLOSED_BEFORE" });
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, \${values}::text::jsonb) RETURNING id::text AS id\`;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pg}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid)\`;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
  const ids = JSON.parse(seed) as { pg: string };

  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  const chat = openOwnerChat(`e2e-le-closed-${ts}`, undefined, OWNER_EMAIL);
  await page.goto(`/edit?page=${ids.pg}&chat=${chat}`);

  const preview = page.frameLocator("iframe[title='Live preview']");
  const h1 = preview.locator("section[data-caelo-module-id] h1");
  await expect(h1).toHaveText("CLOSED_BEFORE", { timeout: 15_000 });

  // The chat is closed elsewhere while this editor still shows it.
  archiveChat(chat);

  await h1.click({ button: "right", position: { x: 8, y: 8 } });
  await preview.getByTestId("caelo-menu-edit").click();
  await page.keyboard.type("Lost text");
  const saved = page.waitForResponse((r) => r.url().includes("editFields"));
  await page.keyboard.press("Enter");
  await saved;
  await expect(
    page.getByText(/Not saved: this chat was archived, so the change was not saved/),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Saved.", { exact: true })).toHaveCount(0);

  // Nothing of it was kept anywhere.
  const stored = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const n = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx\`SELECT count(*)::int AS n FROM site_snapshots WHERE chat_task_id = \${process.env.CHAT}::uuid\`)[0].n;
    });
    await sql.end();
    process.stdout.write(String(n));
    `,
    { CHAT: chat },
  );
  expect(stored).toBe("0");

  // The link to the closed chat opens another chat, and says so (no silent
  // switch); "Continue here" pins the chat that was opened.
  await page.goto(`/edit?page=${ids.pg}&chat=${chat}`);
  const notice = page.getByTestId("chat-notice");
  await expect(notice).toContainText(`The chat “e2e-le-closed-${ts}” was closed`);
  await expect(notice).toContainText("pick or start another chat");
  await notice.getByTestId("chat-notice-continue").click();
  await expect(page).not.toHaveURL(new RegExp(`chat=${chat}`));
  await expect(page.getByTestId("chat-notice")).toHaveCount(0);
});
