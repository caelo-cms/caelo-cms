// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `change_template` re-points a page's templateId, migrating
 * modules where block names line up; orphans drop or relocate per
 * disposition. Verifies via direct AI-tool execution: the response
 * surfaces `migratedBlocks` + `droppedModules`.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

const ts = Date.now();
const NEW_TPL = `e2e-ct-tpl-${ts}`;
const TEST_PAGE = `e2e-ct-page-${ts}`;
const KEPT_MOD_SLUG = `e2e-ct-kept-${ts}`;
const ORPHAN_MOD_SLUG = `e2e-ct-orphan-${ts}`;

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
  // Seed: an "old" template with content + sidebar blocks; a "new"
  // template with content + footer (sidebar is the orphan); a page
  // bound to the old template with one module per block.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`UPDATE layouts SET deleted_at = NULL WHERE slug = 'site-default'\`;
      const layout = ((await tx\`SELECT id::text AS id FROM layouts WHERE slug = 'site-default'\`)[0])?.id;
      const oldSlug = process.env.NEW_TPL + '-old';
      const newSlug = process.env.NEW_TPL;
      const oldTpl = ((await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${oldSlug}, 'CT old', '<body><caelo-slot name="content">_</caelo-slot></body>', '', \${layout}::uuid)
        RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${oldTpl}::uuid, 'content', 'Content', 0), (\${oldTpl}::uuid, 'sidebar', 'Sidebar', 1)\`;
      const newTpl = ((await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${newSlug}, 'CT new', '<body><caelo-slot name="content">_</caelo-slot></body>', '', \${layout}::uuid)
        RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${newTpl}::uuid, 'content', 'Content', 0), (\${newTpl}::uuid, 'footer', 'Footer', 1)\`;
      const kept = ((await tx\`INSERT INTO modules (slug, display_name, type, html) VALUES (\${process.env.KEPT_MOD_SLUG}, 'k', \${process.env.KEPT_MOD_SLUG}, '<p>K</p>') RETURNING id::text AS id\`)[0])?.id;
      const orphan = ((await tx\`INSERT INTO modules (slug, display_name, type, html) VALUES (\${process.env.ORPHAN_MOD_SLUG}, 'o', \${process.env.ORPHAN_MOD_SLUG}, '<p>O</p>') RETURNING id::text AS id\`)[0])?.id;
      const pg = ((await tx\`
        INSERT INTO pages (slug, locale, name, title, template_id, status)
        VALUES (\${process.env.TEST_PAGE}, 'en', 'CT', 'CT', \${oldTpl}::uuid, 'draft')
        RETURNING id::text AS id\`)[0])?.id;
      const ciKept = ((await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${kept}::uuid, '{}'::jsonb) RETURNING id::text AS id\`)[0])?.id;
      const ciOrphan = ((await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${orphan}::uuid, '{}'::jsonb) RETURNING id::text AS id\`)[0])?.id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${pg}::uuid, 'content', 0, \${kept}::uuid, \${ciKept}::uuid), (\${pg}::uuid, 'sidebar', 0, \${orphan}::uuid, \${ciOrphan}::uuid)\`;
    });
    await c.end();
    `,
    { NEW_TPL, TEST_PAGE, KEPT_MOD_SLUG, ORPHAN_MOD_SLUG },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const oldSlug = process.env.NEW_TPL + '-old';
      const newSlug = process.env.NEW_TPL;
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.TEST_PAGE})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.TEST_PAGE}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug IN (\${oldSlug}, \${newSlug}))\`;
      await tx\`DELETE FROM templates WHERE slug IN (\${oldSlug}, \${newSlug})\`;
      await tx\`DELETE FROM modules WHERE slug IN (\${process.env.KEPT_MOD_SLUG}, \${process.env.ORPHAN_MOD_SLUG})\`;
    });
    await c.end();
    `,
    { NEW_TPL, TEST_PAGE, KEPT_MOD_SLUG, ORPHAN_MOD_SLUG },
  );
});

test("change_template migrates content; drops orphan with disposition=drop", () => {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
      import { registerAdminOps } from "@caelo-cms/admin-core";
      const registry = new OperationRegistry();
      registerAdminOps(registry);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
      });
      const ctx = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId: "e2e-ct" };
      const pg = await execute(registry, adapter, ctx, "pages.list", {});
      if (!pg.ok) throw new Error(JSON.stringify(pg.error));
      const page = pg.value.pages.find((p) => p.slug === process.env.TEST_PAGE);
      const tpl = await execute(registry, adapter, ctx, "templates.list", {});
      if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
      const newTpl = tpl.value.templates.find((t) => t.slug === process.env.NEW_TPL);
      const res = await execute(registry, adapter, ctx, "pages.change_template", {
        pageId: page.id,
        newTemplateId: newTpl.id,
        orphanDisposition: { kind: "drop" },
      });
      process.stdout.write(JSON.stringify({ ok: res.ok, value: res.value, error: res.error }));
      `,
    ],
    { env: { ...process.env, TEST_PAGE, NEW_TPL }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const out = JSON.parse(r.stdout) as {
    ok: boolean;
    value?: {
      migratedBlocks: string[];
      droppedModules: { moduleId: string; formerBlock: string }[];
    };
  };
  expect(out.ok).toBe(true);
  expect(out.value?.migratedBlocks).toEqual(["content"]);
  expect(out.value?.droppedModules.length).toBe(1);
  expect(out.value?.droppedModules[0]?.formerBlock).toBe("sidebar");
});
