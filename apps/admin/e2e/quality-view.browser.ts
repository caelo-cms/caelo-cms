// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 / #727 — /settings/quality, the Owner's quality view. A bulk
 * acceptance (one page-check rule accepted on three pages) is listed as ONE
 * group with its reason; the Owner reviews its pages, revokes a picked page
 * through the real form action (routing + CSRF + quality_acceptances.
 * revoke_many), then the rest of the group in one click. Revoked rows stay
 * as history. The acceptances are seeded straight into the table (the
 * shape the bulk accept writes); the ops themselves are covered by the
 * admin-core integration suite.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REASON = `e2e-quality-view-${STAMP}`;
const RULE = `e2e-check/bulk-${STAMP}`;
const SLUGS = ["a", "b", "c"].map((x) => `qv-${STAMP}-${x}`);

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const stamp = process.env.STAMP;
      const lay = await tx\`INSERT INTO layouts (slug, display_name, html, css)
        VALUES (\${"qv-" + stamp + "-lay"}, 'L',
                '<!doctype html><html><head><title>{{title}}</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
                '') RETURNING id\`;
      const tpl = await tx\`INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${"qv-" + stamp + "-tpl"}, 'T', '<main><caelo-slot name="content">_</caelo-slot></main>',
                '', \${lay[0].id}) RETURNING id\`;
      for (const slug of JSON.parse(process.env.SLUGS)) {
        await tx\`UPDATE page_types SET definition = jsonb_set(definition, '{templates}', (definition->'templates') || to_jsonb(\${tpl[0].id}::text)) WHERE id = (SELECT id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL) AND NOT (definition->'templates' ? \${tpl[0].id}::text)\`;
        const page = await tx\`INSERT INTO pages (slug, short_title, title, template_id, status, current_path, page_type_confirmed)
          VALUES (\${slug}, \${slug}, 'Quality view', \${tpl[0].id}, 'published', \${"/" + slug}, true)
          RETURNING id\`;
        await tx\`
          INSERT INTO quality_acceptances (page_id, kind, audit_id, accepted_count, reason, accepted_by)
          VALUES (\${page[0].id}, 'check', \${process.env.RULE}, 1, \${process.env.REASON}, \${actor}::uuid)\`;
      }
    });
    await sql.end();
    `,
    { STAMP, REASON, RULE, SLUGS: JSON.stringify(SLUGS) },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const stamp = process.env.STAMP;
      await tx\`DELETE FROM quality_acceptances WHERE reason = \${process.env.REASON}\`;
      for (const slug of JSON.parse(process.env.SLUGS)) {
        await tx\`DELETE FROM pages WHERE slug = \${slug}\`;
      }
      await tx\`DELETE FROM templates WHERE slug = \${"qv-" + stamp + "-tpl"}\`;
      await tx\`DELETE FROM layouts WHERE slug = \${"qv-" + stamp + "-lay"}\`;
    });
    await sql.end();
    `,
    { STAMP, REASON, SLUGS: JSON.stringify(SLUGS) },
  );
});

test("Owner reviews a bulk acceptance as one group and revokes it in bulk", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/settings/quality");
  await expect(page.getByTestId("quality-gate-card")).toBeVisible();
  const group = page.locator(
    `[data-testid="quality-acceptance-group"][data-group-key="check:${RULE}"]`,
  );
  await expect(group).toBeVisible();
  await expect(group).toContainText("3 page(s)");
  await expect(group).toContainText(REASON);

  // Review the pages, pick one, revoke just that one.
  await group.getByRole("button", { name: "Show pages" }).click();
  const rows = group.getByTestId("quality-acceptance-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("up to 1 error(s)");
  await rows
    .filter({ hasText: `/${SLUGS[0]}` })
    .getByTestId("quality-acceptance-select")
    .check();
  await page.getByLabel("Reason for revoking the selected acceptances (optional)").fill("fix it");
  await page.getByTestId("quality-revoke-selected-btn").click();
  await expect(page.getByText("1 acceptance(s) revoked")).toBeVisible({ timeout: 15_000 });
  await expect(group).toContainText("2 page(s)");

  // The rest of the decision in one click.
  await group.getByTestId("quality-revoke-group-btn").click();
  await expect(page.getByText("2 acceptance(s) revoked")).toBeVisible({ timeout: 15_000 });
  await expect(group).toHaveCount(0);

  // Revoked acceptances stay visible as history.
  const history = page.getByTestId("quality-revoked-acceptances");
  await history.locator("summary").click();
  for (const slug of SLUGS) await expect(history).toContainText(`/${slug}: ${RULE}`);
});
