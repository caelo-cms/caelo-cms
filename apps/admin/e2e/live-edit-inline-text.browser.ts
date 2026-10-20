// SPDX-License-Identifier: MPL-2.0

/**
 * #917 — in-place text editing in the live preview: right-click a text →
 * "Edit text" → type → Enter saves it on the chat's branch without an AI
 * round-trip, and the reloaded preview shows the stored text. Escape
 * restores. A reference from a marked field names the placement field.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor, runBunInline } from "./helpers.js";

const ts = Date.now();
const TPL_SLUG = `e2e-le-inline-tpl-${ts}`;
const MOD_SLUG = `e2e-le-inline-mod-${ts}`;
const PAGE_SLUG = `e2e-le-inline-page-${ts}`;

function runBunInlineCapture(script: string, env: Record<string, string>): string {
  const r = spawnSync("bun", ["-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout;
}

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = \${process.env.PAGE_SLUG})\`;
      await tx\`DELETE FROM pages WHERE slug = \${process.env.PAGE_SLUG}\`;
      await tx\`DELETE FROM content_instance_snapshots WHERE content_instance_id IN (SELECT id FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG}))\`;
      await tx\`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG})\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
});

test("right-click → Edit text saves one field in place; Escape restores", async ({ page }) => {
  const seed = runBunInlineCapture(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const out = {};
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const tpl = await tx\`
        INSERT INTO templates (slug, display_name, html, css, layout_id)
        VALUES (\${process.env.TPL_SLUG}, 'le', '<body><caelo-slot name="content">_</caelo-slot></body>', '', (SELECT id FROM layouts WHERE slug = 'site-default'))
        RETURNING id::text AS id\`;
      await tx\`INSERT INTO template_blocks (template_id, name, display_name, position) VALUES (\${tpl[0].id}::uuid, 'content', 'Content', 0)\`;
      const fields = JSON.stringify([
        { name: "title", kind: "text", label: "Title" },
        { name: "body", kind: "text", label: "Body" },
      ]);
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${process.env.MOD_SLUG}, 'inline mod', \${process.env.MOD_SLUG}, '<section class="hero"><h1>{{title}}</h1><p>{{body}}</p></section>', \${fields}::jsonb)
        RETURNING id::text AS id\`;
      const pg = await tx\`
        INSERT INTO pages (slug, title, template_id, status)
        VALUES (\${process.env.PAGE_SLUG}, 'LE Inline Page', \${tpl[0].id}::uuid, 'draft')
        RETURNING id::text AS id\`;
      out.pg = pg[0].id;
      const values = JSON.stringify({ title: "INLINE_BEFORE", body: "Body stays" });
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, \${values}::jsonb) RETURNING id::text AS id\`;
      out.ci = ci[0].id;
      await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id) VALUES (\${out.pg}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid)\`;
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG },
  );
  const ids = JSON.parse(seed) as { pg: string; ci: string };

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  await page.goto(`/edit?page=${ids.pg}`);

  const preview = page.frameLocator("iframe[title='Live preview']");
  const h1 = preview.locator("section[data-caelo-module-id] h1");
  const p = preview.locator("section[data-caelo-module-id] p");
  await expect(h1).toHaveText("INLINE_BEFORE", { timeout: 15_000 });

  // Escape restores the text and saves nothing.
  await p.click({ button: "right", position: { x: 8, y: 8 } });
  await preview.getByTestId("caelo-menu-edit").click();
  await expect(preview.locator("[data-caelo-editing]")).toBeFocused();
  await page.keyboard.type("discard me");
  await page.keyboard.press("Escape");
  await expect(p).toHaveText("Body stays");
  await expect(preview.locator("[data-caelo-editing]")).toHaveCount(0);

  // Edit text → type → Enter: saved, toast, reloaded preview shows it.
  await h1.click({ button: "right", position: { x: 8, y: 8 } });
  await preview.getByTestId("caelo-menu-edit").click();
  await page.keyboard.type("Fish & chips");
  const saved = page.waitForResponse((r) => r.url().includes("editFieldText"));
  await page.keyboard.press("Enter");
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Text saved.")).toBeVisible({ timeout: 10_000 });
  await expect(h1).toHaveText("Fish & chips", { timeout: 15_000 });
  await expect(p).toHaveText("Body stays");

  // Stored once-escaped, on the chat's branch (live row untouched).
  const stored = JSON.parse(
    runBunInlineCapture(
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      const live = await sql\`SELECT "values"->>'title' AS t FROM content_instances WHERE id = \${process.env.CI}::uuid\`;
      const snap = await sql\`SELECT cis.state->'values'->>'title' AS t FROM content_instance_snapshots cis JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id WHERE cis.content_instance_id = \${process.env.CI}::uuid ORDER BY ss.created_at DESC LIMIT 1\`;
      await sql.end();
      process.stdout.write(JSON.stringify({ live: live[0].t, branch: snap[0]?.t ?? null }));
      `,
      { CI: ids.ci },
    ),
  ) as { live: string; branch: string | null };
  expect(stored).toEqual({ live: "INLINE_BEFORE", branch: "Fish &amp; chips" });
});
