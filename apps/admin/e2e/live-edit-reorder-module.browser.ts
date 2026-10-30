// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module` without `toBlockName` reorders a module within
 * its current block. Drives the AI tool directly via DatabaseAdapter to
 * keep the assertion deterministic. The retired `reorder_module` name is
 * exercised too: older chats, skills and external agents still send it,
 * and the alias table must land it on `move_module`.
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
      const a = ((await tx\`INSERT INTO modules (slug, display_name, type, html) VALUES (\${process.env.MOD_A}, 'a', \${process.env.MOD_A}, '<p>A</p>') RETURNING id::text AS id\`)[0])?.id;
      const b = ((await tx\`INSERT INTO modules (slug, display_name, type, html) VALUES (\${process.env.MOD_B}, 'b', \${process.env.MOD_B}, '<p>B</p>') RETURNING id::text AS id\`)[0])?.id;
      const cc = ((await tx\`INSERT INTO modules (slug, display_name, type, html) VALUES (\${process.env.MOD_C}, 'c', \${process.env.MOD_C}, '<p>C</p>') RETURNING id::text AS id\`)[0])?.id;
      const pg = ((await tx\`INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed) VALUES (\${process.env.PAGE_SLUG}, 'RO', 'RO', \${tplId}::uuid, 'draft', true) RETURNING id::text AS id\`)[0])?.id;
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

test("move_module up moves B to position 0; retired reorder_module down moves it back", () => {
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
      const orderNow = async () => {
        const after = await execute(registry, adapter, ctx, "pages.get_with_modules", { pageId });
        return after.value.page.blocks.find((b) => b.blockName === "content").modules.map((m) => m.slug);
      };
      const moved = await tools.dispatch(
        "move_module",
        { pageId, moduleId, position: "up" },
        ctx,
        { adapter, registry },
      );
      const afterMove = await orderNow();
      // The retired name with its old argument shape (direction).
      const aliased = await tools.dispatch(
        "reorder_module",
        { pageId, moduleId, direction: "down" },
        ctx,
        { adapter, registry },
      );
      const afterAlias = await orderNow();
      process.stdout.write(JSON.stringify({
        moved: { ok: moved.ok, content: moved.content, order: afterMove },
        aliased: { ok: aliased.ok, content: aliased.content, order: afterAlias },
      }));
      `,
    ],
    { env: { ...process.env, PAGE_SLUG, MOD_A, MOD_B, MOD_C }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  type Step = { ok: boolean; content: string; order: string[] };
  const out = JSON.parse(r.stdout) as { moved: Step; aliased: Step };
  expect(out.moved.ok, out.moved.content).toBe(true);
  expect(out.moved.order).toEqual([MOD_B, MOD_A, MOD_C]);
  expect(out.aliased.ok, out.aliased.content).toBe(true);
  expect(out.aliased.order).toEqual([MOD_A, MOD_B, MOD_C]);
});
