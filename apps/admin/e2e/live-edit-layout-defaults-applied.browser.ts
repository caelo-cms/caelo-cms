// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — every page has a chosen page type. `pages.create` without
 * `pageType` (and without a template of exactly one type) is refused with
 * the type list; with `pageType` it resolves the type's default template
 * at create time (stored data — the type's `defaultTemplate` — never a
 * render-time substitute, CLAUDE.md §2). Supersedes the P6.7.6 check that
 * a missing templateId resolved from `site_defaults.default_template_id`,
 * which no longer exists.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const PAGE_SLUG = `defaults-applied-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (
        SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG}
      )\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
    });
    await c.end();
    `,
    { PAGE_SLUG },
  );
});

test("pages.create needs a page type; with one it takes the type's default template", () => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
      import { registerAdminOps } from "@caelo-cms/admin-core";

      const registry = new OperationRegistry();
      registerAdminOps(registry);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
      });

      // System actor — same path the seed uses; no auth/CSRF.
      const ctx = {
        actorId: "00000000-0000-0000-0000-00000000ffff",
        actorKind: "system",
        requestId: "e2e-defaults-applied",
      };

      const refused = await execute(registry, adapter, ctx, "pages.create", {
        slug: process.env.PAGE_SLUG,
        title: "Defaults Applied",
      });
      const created = await execute(registry, adapter, ctx, "pages.create", {
        slug: process.env.PAGE_SLUG,
        title: "Defaults Applied",
        pageType: "home",
      });
      if (!created.ok) throw new Error("pages.create failed: " + JSON.stringify(created.error));

      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      let pageRow, typeRow;
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        pageRow = (await tx\`
          SELECT template_id::text AS template_id, page_type_confirmed FROM pages
          WHERE slug = \${process.env.PAGE_SLUG} LIMIT 1
        \`)[0];
        typeRow = (await tx\`
          SELECT definition->>'defaultTemplate' AS default_template FROM page_types
          WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL
        \`)[0];
      });
      await c.end();
      process.stdout.write(JSON.stringify({
        refused: refused.ok ? null : refused.error.message,
        pageRow,
        typeRow,
      }));
      `,
    ],
    { env: { ...process.env, PAGE_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    refused: string | null;
    pageRow: { template_id: string; page_type_confirmed: boolean } | undefined;
    typeRow: { default_template: string } | undefined;
  };
  expect(parsed.refused).toContain("pageType is required");
  expect(parsed.refused).toContain('"home"');
  expect(parsed.pageRow?.template_id).toBe(parsed.typeRow?.default_template ?? "missing");
  expect(parsed.pageRow?.page_type_confirmed).toBe(true);
});
