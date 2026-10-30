// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — the import panel's Accept names the new page's type. There is no
 * default page type to fall into: the Accept form carries a required page
 * type select, and the accepted page lands on the chosen type with its
 * type confirmed.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const SLUG = `e2e-import-accept-${ts}`;
let runId = "";

test.beforeAll(() => {
  clearLoginRateBucket();
  runId = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let id = "";
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const run = (await tx\`
        INSERT INTO import_runs (source_url, proposed_by, status)
        VALUES (\${"https://" + process.env.SLUG + ".example.test"}, \${actor}::uuid, 'ready_for_review')
        RETURNING id::text AS id\`)[0];
      await tx\`
        INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title, proposed_modules)
        VALUES (\${run.id}::uuid, \${"https://" + process.env.SLUG + ".example.test/a"},
                \${process.env.SLUG}, 'Imported page', '[]'::jsonb)\`;
      id = run.id;
    });
    await sql.end();
    process.stdout.write(id);
    `,
    { SLUG },
  ).trim();
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM import_pages WHERE run_id = \${process.env.RUN_ID}::uuid\`;
      await tx\`DELETE FROM import_runs WHERE id = \${process.env.RUN_ID}::uuid\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.SLUG}\`;
    });
    await sql.end();
    `,
    { RUN_ID: runId, SLUG },
  );
});

test("Accept on an import run asks for the page type and lands the page on it", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto(`/settings/import/${runId}`);
  const typeSelect = page.getByLabel("Page type");
  await expect(typeSelect).toHaveAttribute("required", "");
  await expect(typeSelect).toHaveValue("");
  await typeSelect.selectOption("home");
  await page.getByRole("button", { name: /accept/i }).click();
  await expect(page.getByText(/Promoted to draft page/)).toBeVisible({ timeout: 15_000 });

  const row = JSON.parse(
    runBunInline(
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      let out = null;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        out = (await tx\`
          SELECT pt.slug AS type, p.page_type_confirmed AS confirmed
          FROM pages p JOIN page_types pt ON pt.id = p.page_type_id
          WHERE p.slug = \${process.env.SLUG} LIMIT 1\`)[0] ?? null;
      });
      await sql.end();
      process.stdout.write(JSON.stringify(out));
      `,
      { SLUG },
    ),
  ) as { type: string; confirmed: boolean } | null;
  expect(row).toEqual({ type: "home", confirmed: true });
});
