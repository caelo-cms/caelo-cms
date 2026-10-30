// SPDX-License-Identifier: MPL-2.0

/**
 * #684 — /settings/url_migrations/pending. Regression for the searchviu
 * install: approving a queued URL migration posted to a queue page that did
 * not exist (404), so the migration could never be applied.
 *
 * Seeds a page whose stored address no longer matches its resolved one plus
 * the pending proposal for it, approves from the queue, and checks the page
 * moved and a 301 keeps the old address working.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const SLUG = `e2e-urlmig-${Date.now()}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const slug = process.env.SLUG;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const lay = (await tx\`INSERT INTO layouts (slug, display_name, html, css)
        VALUES (\${slug + "-lay"}, 'L', '<html><body><caelo-layout-content></caelo-layout-content></body></html>', '')
        RETURNING id\`)[0].id;
      const tpl = (await tx\`INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${slug + "-tpl"}, 'T', '<main></main>', '', \${lay})
        RETURNING id\`)[0].id;
      await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl}::text)) WHERE id = (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL) AND NOT (definition->'templates' ? \${tpl}::text)\`;
      const page = (await tx\`INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
        VALUES (\${slug}, 'P', 'P', \${tpl}, 'published', true) RETURNING id::text AS id\`)[0].id;
      const from = "/old/" + slug;
      const to = "/" + slug;
      await tx\`UPDATE pages SET current_path = \${from} WHERE id = \${page}::uuid\`;
      const diff = [{ pageId: page, slug, from, to }];
      await tx\`
        INSERT INTO url_migration_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES ('migrate', \${actor}::uuid,
                (\${JSON.stringify({ diff, reason: "e2e " + slug })}::text)::jsonb,
                (\${JSON.stringify({ pagesMoved: 1, redirectsToCreate: 1, sample: [from + " → " + to], reason: "e2e " + slug })}::text)::jsonb,
                'pending', \${"e2e-" + slug})\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const slug = process.env.SLUG;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM url_migration_pending_actions WHERE payload_hash = \${"e2e-" + slug}\`;
      await tx\`DELETE FROM redirects WHERE from_path = \${"/old/" + slug}\`;
      await tx\`DELETE FROM pages WHERE slug = \${slug}\`;
      await tx\`DELETE FROM templates WHERE slug = \${slug + "-tpl"}\`;
      await tx\`DELETE FROM layouts WHERE slug = \${slug + "-lay"}\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

test("an Owner approves a queued URL migration; the page moves and the old address redirects", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // The overview links the queue (Approvals & safety → URL change proposals).
  await page.goto("/settings");
  await page.getByRole("link", { name: "URL change proposals" }).click();
  await expect(page).toHaveURL("/settings/url_migrations/pending");

  const card = page.getByTestId("url-migration-proposal").filter({ hasText: `e2e ${SLUG}` });
  await expect(card).toContainText(`/old/${SLUG} → /${SLUG}`);
  await card.getByRole("button", { name: "Approve URL change" }).click();
  await expect(page.getByText(/Moved 1 page; 1 redirect/)).toBeVisible();
  await expect(
    page.getByTestId("url-migration-proposal").filter({ hasText: `e2e ${SLUG}` }),
  ).toHaveCount(0);

  const moved = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const slug = process.env.SLUG;
    const out = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const p = await tx\`SELECT current_path FROM pages WHERE slug = \${slug}\`;
      const r = await tx\`SELECT to_path, status_code FROM redirects WHERE from_path = \${"/old/" + slug}\`;
      return { path: p[0]?.current_path, redirect: r[0] ?? null };
    });
    await sql.end();
    console.log(JSON.stringify(out));
    `,
    { SLUG },
  );
  expect(JSON.parse(moved.trim().split("\n").pop() ?? "{}")).toEqual({
    path: `/${SLUG}`,
    redirect: { to_path: `/${SLUG}`, status_code: 301 },
  });
});
