// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `reorder_module` swaps a module's position within its
 * current block. Drives the AI tool directly via DatabaseAdapter to
 * keep the assertion deterministic.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const PAGE_SLUG = `e2e-ro-page-${ts}`;
const MOD_A = `e2e-ro-a-${ts}`;
const MOD_B = `e2e-ro-b-${ts}`;
const MOD_C = `e2e-ro-c-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tplId = ((await tx\`SELECT id::text AS id FROM templates WHERE slug = 'home-template' LIMIT 1\`)[0])?.id;
      const a = ((await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_A}, 'a', '<p>A</p>') RETURNING id::text AS id\`)[0])?.id;
      const b = ((await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_B}, 'b', '<p>B</p>') RETURNING id::text AS id\`)[0])?.id;
      const cc = ((await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_C}, 'c', '<p>C</p>') RETURNING id::text AS id\`)[0])?.id;
      const pg = ((await tx\`INSERT INTO pages (slug, locale, name, title, template_id, status) VALUES (\${process.env.PAGE_SLUG}, 'en', 'RO', 'RO', \${tplId}::uuid, 'draft') RETURNING id::text AS id\`)[0])?.id;
      // v0.12.0 — page_modules.content_instance_id is NOT NULL. Mint
      // one unsynced content_instance per placement before inserting.
      const ciA = ((await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${a}::uuid, '{}'::jsonb) RETURNING id::text AS id\`)[0])?.id;
      const ciB = ((await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${b}::uuid, '{}'::jsonb) RETURNING id::text AS id\`)[0])?.id;
      const ciC = ((await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${cc}::uuid, '{}'::jsonb) RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES
        (\${pg}::uuid, 'content', 0, \${a}::uuid, \${ciA}::uuid),
        (\${pg}::uuid, 'content', 1, \${b}::uuid, \${ciB}::uuid),
        (\${pg}::uuid, 'content', 2, \${cc}::uuid, \${ciC}::uuid)\`;
    });
    await c.end();
    `,
    { PAGE_SLUG, MOD_A, MOD_B, MOD_C },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM modules WHERE slug IN (\${process.env.MOD_A}, \${process.env.MOD_B}, \${process.env.MOD_C})\`;
    });
    await c.end();
    `,
    { PAGE_SLUG, MOD_A, MOD_B, MOD_C },
  );
});

test("reorder_module up: module B moves from position 1 to 0", () => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
      import { registerAdminOps, createDefaultToolRegistry } from "@caelo-cms/admin-core";
      const registry = new OperationRegistry();
      registerAdminOps(registry);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
      });
      const ctx = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-ro" };
      const pg = await execute(registry, adapter, ctx, "pages.list", {});
      const pageId = pg.value.pages.find((p) => p.slug === process.env.PAGE_SLUG).id;
      const got = await execute(registry, adapter, ctx, "pages.get_with_modules", { pageId });
      const block = got.value.page.blocks.find((b) => b.blockName === "content");
      const moduleId = block.modules.find((m) => m.slug === process.env.MOD_B).moduleId;

      const tools = createDefaultToolRegistry();
      const result = await tools.dispatch(
        "reorder_module",
        { pageId, moduleId, direction: "up" },
        ctx,
        { adapter, registry },
      );
      const after = await execute(registry, adapter, ctx, "pages.get_with_modules", { pageId });
      const order = after.value.page.blocks.find((b) => b.blockName === "content").modules.map((m) => m.slug);
      process.stdout.write(JSON.stringify({ ok: result.ok, content: result.content, order }));
      `,
    ],
    { env: { ...process.env, PAGE_SLUG, MOD_A, MOD_B, MOD_C }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const out = JSON.parse(r.stdout) as { ok: boolean; content: string; order: string[] };
  expect(out.ok).toBe(true);
  expect(out.order).toEqual([MOD_B, MOD_A, MOD_C]);
});
