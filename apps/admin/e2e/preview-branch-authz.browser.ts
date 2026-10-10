// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #569 — the live-edit preview routes only render a chat branch the
 * signed-in operator may see.
 *
 * Editor A runs an isolated experiment that rewrites a module on a page.
 * Editor B, also signed in, asks the preview routes for A's branch by id:
 * both `/edit/preview/<page>?branch=` and `/edit/preview-by-path/<path>?branch=`
 * answer 404, exactly like for a branch id that does not exist. A still sees
 * the experiment; the shared site draft stays visible to B. The rule itself
 * (and the AI / system / Owner cases) is covered at the op level by
 * packages/admin-core/src/__tests__/branch-visibility.integration.test.ts.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const TAG = `e2e569-${Date.now()}`;
const PASSWORD = "branch authz dev password";
const EMAIL_A = `${TAG}-a@example.com`;
const EMAIL_B = `${TAG}-b@example.com`;

let seed: { pageId: string; slug: string; experiment: string; draft: string };

test.beforeAll(() => {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { hashPassword, registerAdminOps } from "@caelo-cms/admin-core";
    const tag = process.env.T569_TAG;
    const pwd = await hashPassword(process.env.T569_PASSWORD);
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const seeded = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const ids = [];
      for (const email of [process.env.T569_EMAIL_A, process.env.T569_EMAIL_B]) {
        const a = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${email}) RETURNING id::text AS id\`;
        await tx\`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
                 VALUES (\${a[0].id}::uuid, \${email}, \${pwd}, false, now())\`;
        await tx\`INSERT INTO user_roles (user_id, role_id) SELECT \${a[0].id}::uuid, id FROM roles WHERE name = 'editor'\`;
        ids.push(a[0].id);
      }
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (\${tag + "-tpl"}, 'E2E 569', '<body><caelo-slot name="content">_</caelo-slot></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position)
               VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${tag + "-mod"}, 'E2E 569', \${tag + "-mod"}, '<p>live copy</p>', '[]'::jsonb)
        RETURNING id::text AS id\`;
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, '{}'::jsonb) RETURNING id::text AS id\`;
      const page = await tx\`
        INSERT INTO pages (slug, name, title, template_id)
        VALUES (\${tag + "-page"}, 'E2E 569', 'E2E 569', \${tpl[0].id}::uuid)
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
               VALUES (\${page[0].id}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid, 'unsynced')\`;
      return { a: ids[0], pageId: page[0].id, moduleId: mod[0].id };
    });
    await db.end();
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
    });
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const run = async (ctx, op, input) => {
      const r = await execute(registry, adapter, ctx, op, input);
      if (!r.ok) throw new Error(op + ": " + JSON.stringify(r.error));
      return r.value;
    };
    const editorA = { actorId: seeded.a, actorKind: "human", requestId: tag };
    const exp = await run(editorA, "chat.create_session", { title: tag + " experiment", isolation: "experiment" });
    const draft = await run(editorA, "chat.create_session", { title: tag + " draft" });
    await run(
      { ...editorA, actorKind: "ai", chatBranchId: exp.chatBranchId, chatTaskId: exp.chatSessionId },
      "modules.update",
      { moduleId: seeded.moduleId, html: "<p>secret experiment</p>" },
    );
    await adapter.close();
    process.stdout.write(JSON.stringify({
      pageId: seeded.pageId, slug: tag + "-page", experiment: exp.chatBranchId, draft: draft.chatBranchId,
    }));
    `,
    {
      T569_TAG: TAG,
      T569_PASSWORD: PASSWORD,
      T569_EMAIL_A: EMAIL_A,
      T569_EMAIL_B: EMAIL_B,
    },
  );
  seed = JSON.parse(out) as typeof seed;
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test("another editor's isolated branch preview is a 404", async ({ page }) => {
  await signIn(page, EMAIL_B);
  const byId = await page.request.get(`/edit/preview/${seed.pageId}?branch=${seed.experiment}`);
  expect(byId.status()).toBe(404);
  expect(await byId.text()).not.toContain("secret experiment");
  const byPath = await page.request.get(
    `/edit/preview-by-path/${seed.slug}?branch=${seed.experiment}`,
  );
  expect(byPath.status()).toBe(404);
  // Indistinguishable from a branch that does not exist.
  const ghost = await page.request.get(
    `/edit/preview/${seed.pageId}?branch=${crypto.randomUUID()}`,
  );
  expect(ghost.status()).toBe(404);
  // A malformed id is "not found" too, not a validation error.
  const malformed = await page.request.get(`/edit/preview/${seed.pageId}?branch=not-a-uuid`);
  expect(malformed.status()).toBe(404);
  const malformedByPath = await page.request.get(
    `/edit/preview-by-path/${seed.slug}?branch=not-a-uuid`,
  );
  expect(malformedByPath.status()).toBe(404);
  // The shared draft is everyone's.
  const draft = await page.request.get(`/edit/preview/${seed.pageId}?branch=${seed.draft}`);
  expect(draft.status()).toBe(200);
});

test("the experiment's owner still previews it", async ({ page }) => {
  await signIn(page, EMAIL_A);
  const res = await page.request.get(`/edit/preview/${seed.pageId}?branch=${seed.experiment}`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("secret experiment");
});
