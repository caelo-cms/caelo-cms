// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 review pass — verifies that `pages.create` resolves a missing
 * `templateId` from `site_defaults`. Asserts the no-fallback contract:
 * defaults live in stored data, consulted at create time, not silently
 * substituted at render time.
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

test("pages.create with no templateId resolves from site_defaults", () => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
      import { registerAdminOps } from "@caelo/admin-core";

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

      const created = await execute(registry, adapter, ctx, "pages.create", {
        slug: process.env.PAGE_SLUG,
        locale: "en",
        title: "Defaults Applied",
        // templateId intentionally omitted — resolver must fall back
        // to site_defaults.default_template_id at create time.
      });
      if (!created.ok) throw new Error("pages.create failed: " + JSON.stringify(created.error));

      // Read site_defaults and the new page's template_id; they must match.
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      let pageRow, defaultsRow;
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        pageRow = (await tx\`
          SELECT template_id::text AS template_id FROM pages
          WHERE slug = \${process.env.PAGE_SLUG} LIMIT 1
        \`)[0];
        defaultsRow = (await tx\`
          SELECT default_template_id::text AS default_template_id FROM site_defaults WHERE id = 1
        \`)[0];
      });
      await c.end();
      process.stdout.write(JSON.stringify({ pageRow, defaultsRow }));
      `,
    ],
    { env: { ...process.env, PAGE_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    pageRow: { template_id: string } | undefined;
    defaultsRow: { default_template_id: string } | undefined;
  };
  expect(parsed.pageRow?.template_id).toBeTruthy();
  expect(parsed.defaultsRow?.default_template_id).toBeTruthy();
  expect(parsed.pageRow?.template_id).toBe(parsed.defaultsRow?.default_template_id ?? "");
});
