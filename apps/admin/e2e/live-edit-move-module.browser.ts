// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `move_module` splices a module from its current block to
 * another block on the same page. Verifies via direct AI-tool
 * dispatch that the module's block_name flips and the source block
 * shrinks.
 *
 * Setup: a multi-block template (content + sidebar) with one module
 * in `content`. Test moves it to `sidebar` at the bottom.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const ts = Date.now();
const TPL_SLUG = `e2e-mv-tpl-${ts}`;
const PAGE_SLUG = `e2e-mv-page-${ts}`;
const MOD_SLUG = `e2e-mv-mod-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE layouts SET deleted_at = NULL WHERE slug = 'site-default'\`;
      const layout = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug = 'site-default'\`)[0])?.id;
      const tpl = ((await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'mv', '<body><caelo-slot name="content">_</caelo-slot><caelo-slot name="sidebar">_</caelo-slot></body>', '', \${layout}::uuid)
        RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES
        (\${tpl}::uuid, 'content', 'Content', 0),
        (\${tpl}::uuid, 'sidebar', 'Sidebar', 1)\`;
      const m = ((await tx\`INSERT INTO modules (slug, display_name, html) VALUES (\${process.env.MOD_SLUG}, 'mv', '<p>MV</p>') RETURNING id::text AS id\`)[0])?.id;
      const pg = ((await tx\`INSERT INTO pages (slug, locale, name, title, template_id, status) VALUES (\${process.env.PAGE_SLUG}, 'en', 'MV', 'MV', \${tpl}::uuid, 'draft') RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id) VALUES (\${pg}::uuid, 'content', 0, \${m}::uuid)\`;
    });
    await c.end();
    `,
    { TPL_SLUG, PAGE_SLUG, MOD_SLUG },
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
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
    });
    await c.end();
    `,
    { TPL_SLUG, PAGE_SLUG, MOD_SLUG },
  );
});

test("move_module flips block_name from content to sidebar", () => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
      import { registerAdminOps, createDefaultToolRegistry } from "@caelo/admin-core";
      const registry = new OperationRegistry();
      registerAdminOps(registry);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
      });
      const ctx = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-mv" };
      const pg = await execute(registry, adapter, ctx, "pages.list", {});
      const pageId = pg.value.pages.find((p) => p.slug === process.env.PAGE_SLUG).id;
      const got = await execute(registry, adapter, ctx, "pages.get_with_modules", { pageId });
      const moduleId = got.value.page.blocks
        .flatMap((b) => b.modules)
        .find((m) => m.slug === process.env.MOD_SLUG).moduleId;

      const tools = createDefaultToolRegistry();
      const result = await tools.dispatch(
        "move_module",
        { pageId, moduleId, toBlockName: "sidebar", position: "bottom" },
        ctx,
        { adapter, registry },
      );
      const after = await execute(registry, adapter, ctx, "pages.get_with_modules", { pageId });
      const blocks = after.value.page.blocks.map((b) => ({ b: b.blockName, n: b.modules.length }));
      process.stdout.write(JSON.stringify({ ok: result.ok, content: result.content, blocks }));
      `,
    ],
    { env: { ...process.env, PAGE_SLUG, MOD_SLUG }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const out = JSON.parse(r.stdout) as {
    ok: boolean;
    content: string;
    blocks: { b: string; n: number }[];
  };
  expect(out.ok).toBe(true);
  // Source block (content) loses its module; destination (sidebar) gains it.
  const sidebar = out.blocks.find((x) => x.b === "sidebar");
  const content = out.blocks.find((x) => x.b === "content");
  expect(sidebar?.n).toBe(1);
  expect(content?.n ?? 0).toBe(0);
});
