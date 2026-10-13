// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 part 3 — the admin shows the page hierarchy and moves pages.
 *
 * /content/pages lists a child indented under its section with its full
 * URL path; the page's Location card moves it to another section through
 * the parent picker, and the page then reports its new path.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.describe.configure({ mode: "serial" });
test.beforeAll(clearLoginRateBucket);

const TAG = `e2e690ui-${Date.now()}`;
const PASSWORD = "nested pages ui dev password";
const EMAIL = `${TAG}@example.com`;

let seed: { childId: string; sectionA: string; sectionB: string; child: string };

test.beforeAll(() => {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { hashPassword, registerAdminOps } from "@caelo-cms/admin-core";
    const tag = process.env.T690_TAG;
    const pwd = await hashPassword(process.env.T690_PASSWORD);
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const seeded = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const a = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${process.env.T690_EMAIL}) RETURNING id::text AS id\`;
      await tx\`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
               VALUES (\${a[0].id}::uuid, \${process.env.T690_EMAIL}, \${pwd}, false, now())\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) SELECT \${a[0].id}::uuid, id FROM roles WHERE name = 'editor'\`;
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (\${tag + "-tpl"}, 'E2E 690 UI', '<body><caelo-slot name="content">_</caelo-slot></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position)
               VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      return { actorId: a[0].id, templateId: tpl[0].id };
    });
    await db.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const ctx = { actorId: seeded.actorId, actorKind: "human", requestId: tag };
    const create = async (slug, parentPageId) => {
      const r = await execute(registry, adapter, ctx, "pages.create", {
        slug, title: slug, templateId: seeded.templateId, status: "draft",
        ...(parentPageId ? { parentPageId } : {}),
      });
      if (!r.ok) throw new Error("pages.create: " + JSON.stringify(r.error));
      return r.value.pageId;
    };
    const a = await create(tag + "-a");
    await create(tag + "-b");
    const child = await create(tag + "-child", a);
    await adapter.close();
    process.stdout.write(JSON.stringify({
      childId: child, sectionA: tag + "-a", sectionB: tag + "-b", child: tag + "-child",
    }));
    `,
    { T690_TAG: TAG, T690_PASSWORD: PASSWORD, T690_EMAIL: EMAIL },
  );
  seed = JSON.parse(out) as typeof seed;
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test("the page list shows the child indented under its section with its full path", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/content/pages");
  const childRow = page
    .getByTestId("page-row")
    .filter({ hasText: `/${seed.sectionA}/${seed.child}` });
  await expect(childRow).toHaveAttribute("data-depth", "1");
});

test("the Location card moves the page under another section", async ({ page }) => {
  await signIn(page);
  await page.goto(`/content/pages/${seed.childId}`);
  await expect(page.getByTestId("page-path")).toHaveText(`/${seed.sectionA}/${seed.child}`);
  // The parent picker is the Location card's combobox; open its list and
  // type to filter.
  const picker = page.getByLabel("Parent page");
  await page.getByRole("button", { name: "Toggle options" }).click();
  await picker.pressSequentially(`/${seed.sectionB}`);
  await page.getByRole("option", { name: new RegExp(`^/${seed.sectionB} `) }).click();
  await page.getByTestId("move-page-btn").click();
  await expect(page.getByText(/Moved — 1 URL/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("page-path")).toHaveText(`/${seed.sectionB}/${seed.child}`);
});
