// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative plugin admin panels: a plugin's admin page is data in its
 * manifest, rendered by the admin's one generic renderer, and it exists
 * only while the plugin runs.
 *
 * Uses a plugin installed at runtime (one plugin model: a shipped plugin's
 * panel is the same thing):
 *   1. While the plugin is not active there is no "Plugins" nav entry for
 *      it and its page is a 404.
 *   2. Once the Owner approves it, the nav lists the panel; its form adds a
 *      row, the table shows it (as text), and a row action changes it.
 *   3. A role without the panel's permission sees no nav entry and is
 *      refused the page.
 *   4. Disabled again, the panel is gone: no nav entry, 404.
 */

import { expect, type Page, test } from "@playwright/test";
import { acceptConfirm, clearLoginRateBucket, runBunInline } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const ts = Date.now();
const SLUG = `e2e-panel-${ts}`;
const PANEL_URL = `/plugins/${SLUG}/items`;
const READER_EMAIL = `e2e-panel-reader-${ts}@example.com`;
const READER_PASSWORD = "panel reader password";
const READER_ROLE = `e2e-panel-reader-${ts}`;
const ITEM = `<b>Item ${ts}</b>`;
// Unique per run: an earlier run's plugin may still be active.
const PANEL_TITLE = `E2E items ${ts}`;

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: { items: { id: "uuid", title: "string", status: "enum:new,archived" } },
  operations: ["list", "add", "archive"],
  hasStaticRender: false,
  adminPanels: [
    {
      slug: "items",
      title: PANEL_TITLE,
      description: "Items of the e2e panel plugin.",
      icon: "inbox",
      permission: "settings.write",
      sections: [
        {
          kind: "form",
          id: "add",
          title: "Add an item",
          operation: "add",
          fields: [{ arg: "title", label: "Title", input: "text", required: true, maxLength: 120 }],
          submitLabel: "Add item",
          successMessage: "Added {title}.",
        },
        {
          kind: "table",
          id: "items",
          title: "Items",
          operation: "list",
          rowsKey: "items",
          rowKey: "id",
          emptyMessage: "No items yet.",
          columns: [
            { key: "title", label: "Title", format: "text" },
            { key: "status", label: "Status", format: "badge" },
          ],
          rowActions: [
            {
              id: "archive",
              label: "Archive",
              operation: "archive",
              variant: "outline",
              rowArgs: { id: "id" },
              when: [{ key: "status", in: ["new"] }],
              successMessage: "Archived.",
            },
          ],
        },
      ],
    },
  ],
};

const source = `export default {
  slug: ${JSON.stringify(SLUG)},
  version: "1.0.0",
  tier: 2,
  schema: { items: { id: "uuid", title: "string", status: "enum:new,archived" } },
  operations: {
    list: async (ctx) => ({ items: await ctx.query.list("items", { limit: 100 }) }),
    add: async (ctx, args) => {
      await ctx.query.insert("items", { title: args.title, status: "new" });
      return { title: args.title };
    },
    archive: async (ctx, args) => {
      await ctx.query.update("items", args.id, { status: "archived" });
      return { id: args.id };
    },
  },
};`;

test.beforeAll(() => {
  clearLoginRateBucket();
  runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps, hashPassword } from "@caelo-cms/admin-core";
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const ctx = { actorKind: "system", actorId: "00000000-0000-0000-0000-00000000ffff", requestId: "e2e-panel-submit" };
    const r = await execute(registry, adapter, ctx, "plugins.submit", JSON.parse(process.env.PLUGIN_INPUT));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    // A reader: may read content, may not open the panel (settings.write).
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const pwd = await hashPassword(process.env.READER_PASSWORD);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const role = await tx\`INSERT INTO roles (name, description) VALUES (\${process.env.READER_ROLE}, 'Panel spec reader') RETURNING id\`;
      await tx\`INSERT INTO role_permissions (role_id, permission_id) SELECT \${role[0].id}, p.id FROM permissions p WHERE p.name IN ('content.read')\`;
      const actor = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', 'E2E panel reader') RETURNING id::text AS id\`;
      await tx\`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at) VALUES (\${actor[0].id}::uuid, \${process.env.READER_EMAIL}, \${pwd}, false, now())\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) VALUES (\${actor[0].id}::uuid, \${role[0].id})\`;
    });
    await sql.end();
    await adapter.close();
    `,
    {
      PLUGIN_INPUT: JSON.stringify({ slug: SLUG, version: "1.0.0", manifest, source }),
      READER_EMAIL,
      READER_PASSWORD,
      READER_ROLE,
    },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = \${process.env.READER_EMAIL})\`;
      await tx\`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = \${process.env.READER_EMAIL})\`;
      await tx\`DELETE FROM users WHERE email = \${process.env.READER_EMAIL}\`;
      await tx\`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = \${process.env.READER_ROLE})\`;
      await tx\`DELETE FROM roles WHERE name = \${process.env.READER_ROLE}\`;
    });
    await sql.end();
    `,
    { READER_EMAIL, READER_ROLE },
  );
});

async function login(page: Page, email: string, password: string): Promise<void> {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
}

const navLink = (page: Page) =>
  page.getByRole("navigation", { name: "Main navigation" }).locator(`a[href="${PANEL_URL}"]`);

test("an inactive plugin has no panel: no nav entry, 404", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/content/pages");
  await expect(navLink(page)).toHaveCount(0);
  const res = await page.goto(PANEL_URL);
  expect(res?.status()).toBe(404);
});

test("approved, the panel renders, its form and row action work", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/plugins");
  const row = page.getByRole("row").filter({ hasText: SLUG });
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByRole("main").getByText(`Activated ${SLUG}.`, { exact: true }),
  ).toBeVisible();

  await page.goto("/content/pages");
  await expect(page.getByTestId("nav-plugins")).toBeVisible();
  await navLink(page).click();
  await expect(page).toHaveURL(PANEL_URL);
  await expect(page.getByRole("heading", { name: PANEL_TITLE })).toBeVisible();
  await expect(page.getByText("No items yet.")).toBeVisible();

  const form = page.getByTestId("panel-section-add");
  await form.getByLabel("Title").fill(ITEM);
  await form.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added ${ITEM}.` })).toBeVisible();

  // Plugin data renders as text, never as markup.
  const item = page.getByTestId("panel-row").filter({ hasText: ITEM });
  await expect(item).toHaveCount(1);
  await expect(item.locator("b")).toHaveCount(0);
  await expect(item.getByText("new", { exact: true })).toBeVisible();

  await item.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived." })).toBeVisible();
  await expect(item.getByText("archived", { exact: true })).toBeVisible();
  // The action is offered only while its condition holds.
  await expect(item.getByRole("button", { name: "Archive" })).toHaveCount(0);
});

test("a role without the panel's permission sees nothing", async ({ page }) => {
  await login(page, READER_EMAIL, READER_PASSWORD);
  await page.goto("/content/pages");
  await expect(navLink(page)).toHaveCount(0);
  const res = await page.goto(PANEL_URL);
  expect(res?.status()).toBe(403);
});

test("disabled again, the panel is gone", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/plugins");
  const row = page.getByRole("row").filter({ hasText: SLUG });
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await acceptConfirm(page);
  await expect(
    page.getByRole("main").getByText(`Disabled ${SLUG}.`, { exact: true }),
  ).toBeVisible();

  await page.goto("/content/pages");
  await expect(navLink(page)).toHaveCount(0);
  const res = await page.goto(PANEL_URL);
  expect(res?.status()).toBe(404);
});
