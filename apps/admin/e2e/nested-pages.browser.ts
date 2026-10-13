// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 — nested page URLs, end to end through the admin server.
 *
 * Seeds a section page with a child created under it, plus a top-level
 * page that `pages.move_many` then moves under the section. Signed in as
 * an editor, the live-edit preview answers at the NESTED paths
 * (`/<section>/<child>`, `/<section>/<moved>`), and the moved page's old
 * top-level path no longer resolves to it — it now lives only at its new
 * URL (the 301 carries visitors on the public site).
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const TAG = `e2e690-${Date.now()}`;
const PASSWORD = "nested pages dev password";
const EMAIL = `${TAG}@example.com`;

let seed: { section: string; child: string; moved: string; redirectTo: string | null };

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
        VALUES (\${tag + "-tpl"}, 'E2E 690', '<body><caelo-slot name="content">_</caelo-slot></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position)
               VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      return { actorId: a[0].id, templateId: tpl[0].id };
    });
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const ctx = { actorId: seeded.actorId, actorKind: "human", requestId: tag };
    const run = async (op, input) => {
      const r = await execute(registry, adapter, ctx, op, input);
      if (!r.ok) throw new Error(op + ": " + JSON.stringify(r.error));
      return r.value;
    };
    const create = (slug, parentPageId) =>
      run("pages.create", {
        slug, title: slug, templateId: seeded.templateId, status: "draft",
        ...(parentPageId ? { parentPageId } : {}),
      });
    const section = await create(tag + "-section");
    await create(tag + "-child", section.pageId);
    const moved = await create(tag + "-moved");
    await run("pages.move_many", { moves: [{ pageId: moved.pageId, parentPageId: section.pageId }] });
    await adapter.close();
    const red = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx\`SELECT to_path FROM redirects WHERE from_path = \${"/" + tag + "-moved"}\`;
    });
    await db.end();
    process.stdout.write(JSON.stringify({
      section: tag + "-section", child: tag + "-child", moved: tag + "-moved",
      redirectTo: red[0]?.to_path ?? null,
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

test("nested pages preview at their parent-chain URLs; a moved page leaves its old URL", async ({
  page,
}) => {
  expect(seed.redirectTo).toBe(`/${seed.section}/${seed.moved}`);
  await signIn(page);

  const child = await page.request.get(`/edit/preview-by-path/${seed.section}/${seed.child}`);
  expect(child.status()).toBe(200);
  expect(await child.text()).toContain(`"path":"/${seed.section}/${seed.child}"`);

  const moved = await page.request.get(`/edit/preview-by-path/${seed.section}/${seed.moved}`);
  expect(moved.status()).toBe(200);

  const oldUrl = await page.request.get(`/edit/preview-by-path/${seed.moved}`, {
    maxRedirects: 0,
  });
  expect(oldUrl.status()).toBe(404);
});
