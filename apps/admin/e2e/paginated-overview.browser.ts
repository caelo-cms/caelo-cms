// SPDX-License-Identifier: MPL-2.0

/**
 * #1257 — a paginated overview in the Live Edit preview, end to end
 * through the admin server.
 *
 * Seeds a hub page with six published child pages and a module whose
 * `list` field paginates them two per page, with a pager. Signed in as an
 * editor, the preview answers the follow-up pages at `<hub>/page/<n>`
 * (the pager's links), each with its own slice and its own path for the
 * editor's address bar, and a page number beyond the sequence is a 404.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.describe.configure({ mode: "serial" });
test.beforeAll(clearLoginRateBucket);

const TAG = `e2e1257-${Date.now()}`;
const PASSWORD = "paginated overview dev password";
const EMAIL = `${TAG}@example.com`;

let hub = "";

test.beforeAll(() => {
  const out = runBunInline(
    `
    import { SQL } from "bun";
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { hashPassword, registerAdminOps } from "@caelo-cms/admin-core";
    const tag = process.env.T1257_TAG;
    const pwd = await hashPassword(process.env.T1257_PASSWORD);
    const db = new SQL(process.env.ADMIN_DATABASE_URL);
    const seeded = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const a = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${process.env.T1257_EMAIL}) RETURNING id::text AS id\`;
      await tx\`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
               VALUES (\${a[0].id}::uuid, \${process.env.T1257_EMAIL}, \${pwd}, false, now())\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) SELECT \${a[0].id}::uuid, id FROM roles WHERE name = 'editor'\`;
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, layout_id)
        VALUES (\${tag + "-tpl"}, 'E2E 1257', '<body><caelo-slot name="content">_</caelo-slot></body>',
                (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
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
    const run = async (op, input) => {
      const r = await execute(registry, adapter, ctx, op, input);
      if (!r.ok) throw new Error(op + ": " + JSON.stringify(r.error));
      return r.value;
    };
    const create = (slug, title, parentPageId) =>
      run("pages.create", {
        slug, title, templateId: seeded.templateId, status: "published",
        ...(parentPageId ? { parentPageId } : {}),
      });
    const hub = await create(tag + "-hub", "E2E 1257 hub");
    for (let i = 1; i <= 6; i += 1) await create(tag + "-g" + i, "E2E 1257 guide " + i, hub.pageId);
    await run("pages.build_page", {
      page: { pageId: hub.pageId },
      modules: [{
        blockName: "content",
        displayName: tag + " overview",
        description: "Every guide, two per page, with a pager.",
        kind: "content",
        html: '<ul>{{#guides}}<li class="guide">{{title}}</li>{{/guides}}</ul><nav>{{#pager}}{{#is_current}}<span aria-current="page">{{number}}</span>{{/is_current}}{{^is_current}}<a class="pg" href="{{link}}">{{number}}</a>{{/is_current}}{{/pager}}</nav>',
        fields: [
          { name: "guides", kind: "list", label: "Guides", listType: "links", bind: "source",
            source: { kind: "query", editable: [], defaults: { parent: "caelo:page/" + hub.pageId, order: "title_asc" } },
            paginate: { per_page: 2 } },
          { name: "pager", kind: "list", label: "Pages", listType: "links", bind: "source",
            source: { kind: "system", name: "pagination" } },
        ],
        content: { source: "inline", values: {} },
      }],
    });
    await adapter.close();
    process.stdout.write(JSON.stringify({ hub: tag + "-hub" }));
    `,
    { T1257_TAG: TAG, T1257_PASSWORD: PASSWORD, T1257_EMAIL: EMAIL },
  );
  hub = (JSON.parse(out) as { hub: string }).hub;
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

const guides = (html: string): string[] =>
  [...html.matchAll(/<li class="guide"[^>]*>([^<]+)<\/li>/g)].map((m) => m[1] as string);

test("the preview serves every page of a paginated overview at <path>/page/<n>", async ({
  page,
}) => {
  await signIn(page);

  const first = await page.request.get(`/edit/preview-by-path/${hub}`);
  expect(first.status()).toBe(200);
  const firstHtml = await first.text();
  expect(guides(firstHtml)).toEqual(["E2E 1257 guide 1", "E2E 1257 guide 2"]);
  // The pager links the follow-up pages; the iframe navigates them as paths.
  expect(firstHtml).toMatch(new RegExp(`href="/${hub}/page/2/?"`));
  expect(firstHtml).toMatch(new RegExp(`href="/${hub}/page/3/?"`));

  const third = await page.request.get(`/edit/preview-by-path/${hub}/page/3`);
  expect(third.status()).toBe(200);
  const thirdHtml = await third.text();
  expect(guides(thirdHtml)).toEqual(["E2E 1257 guide 5", "E2E 1257 guide 6"]);
  expect(thirdHtml).toContain('<span aria-current="page">3</span>');
  expect(thirdHtml).toContain(`"path":"/${hub}/page/3"`);

  const beyond = await page.request.get(`/edit/preview-by-path/${hub}/page/4`);
  expect(beyond.status()).toBe(404);
});
