// SPDX-License-Identifier: MPL-2.0

/**
 * #918 — in-place editing beyond plain text: a link's text + target in one
 * save, shared content (on two pages) asking "everywhere or only here",
 * and "Replace image…" through the media picker.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  archiveChat,
  clearLoginRateBucket,
  openOwnerChat,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

const ts = Date.now();
/** This spec's own Live Edit chat (#1081); archived in afterAll. */
let chat: string | null = null;
const TPL_SLUG = `e2e-le-shared-tpl-${ts}`;
const MOD_SLUG = `e2e-le-shared-mod-${ts}`;
const PAGE_SLUG = `e2e-le-shared-page-${ts}`;
const TWIN_SLUG = `e2e-le-shared-twin-${ts}`;
const MEDIA_SLUG = `e2e-cup-${ts}`;

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
  if (chat) archiveChat(chat);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM page_layout_snapshots WHERE page_id IN (SELECT id FROM pages WHERE slug IN (\${process.env.PAGE_SLUG}, \${process.env.TWIN_SLUG}))\`;
      await tx\`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (\${process.env.PAGE_SLUG}, \${process.env.TWIN_SLUG}))\`;
      await tx\`DELETE FROM pages WHERE slug IN (\${process.env.PAGE_SLUG}, \${process.env.TWIN_SLUG})\`;
      await tx\`DELETE FROM content_instance_snapshots WHERE content_instance_id IN (SELECT id FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG}))\`;
      await tx\`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug = \${process.env.MOD_SLUG})\`;
      await tx\`DELETE FROM modules WHERE slug = \${process.env.MOD_SLUG}\`;
      await tx\`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = \${process.env.TPL_SLUG})\`;
      await tx\`DELETE FROM templates WHERE slug = \${process.env.TPL_SLUG}\`;
      await tx\`DELETE FROM media_assets WHERE slug = \${process.env.MEDIA_SLUG}\`;
    });
    await sql.end();
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG, TWIN_SLUG, MEDIA_SLUG },
  );
});

/** Latest branch snapshot values of a content instance (null: none yet). */
function branchValues(ci: string): { title?: unknown; links?: unknown } | null {
  return JSON.parse(
    runBunInlineCapture(
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      // RLS is forced for the owner role too: read as the system actor.
      const v = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const r = await tx\`SELECT cis.state->'values' AS v FROM content_instance_snapshots cis JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id WHERE cis.content_instance_id = \${process.env.CI}::uuid ORDER BY ss.created_at DESC LIMIT 1\`;
        return r[0]?.v ?? null;
      });
      await sql.end();
      process.stdout.write(JSON.stringify(typeof v === "string" ? JSON.parse(v) : v));
      `,
      { CI: ci },
    ),
  ) as { title?: unknown; links?: unknown } | null;
}

test("link text + target, shared content scope, and image replace", async ({ page }) => {
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
        { name: "links", kind: "list", listType: "links", label: "Links" },
        { name: "photo", kind: "image", label: "Photo" },
        { name: "photo_alt", kind: "text", label: "Photo alt text" },
      ]);
      const html = '<section class="card"><h1>{{title}}</h1><nav>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</nav><img src="{{photo}}" alt="{{photo_alt}}" width="48" height="48"></section>';
      const mod = await tx\`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (\${process.env.MOD_SLUG}, 'shared mod', \${process.env.MOD_SLUG}, \${html}, \${fields}::text::jsonb)
        RETURNING id::text AS id\`;
      // Every value of the placement is link-checked on each save (#724),
      // so the seed links nowhere internal; the picked image is a real asset.
      const values = JSON.stringify({
        title: "SHARED_TITLE",
        links: [{ id: "00000000-0000-4000-9000-000000000001", node: "link", values: { label: "Docs", link: { href: "https://example.com/docs" } } }],
        photo: "https://example.com/old-photo.png",
        photo_alt: "Old photo",
      });
      const media = await tx\`
        INSERT INTO media_assets (sha256, original_name, mime, size_bytes, width, height, alt, storage_key, created_by, slug)
        VALUES (\${process.env.MEDIA_SLUG}, 'e2e-cup.png', 'image/png', 1, 1, 1, 'A blue cup', \${process.env.MEDIA_SLUG}, (SELECT id FROM actors WHERE kind = 'system' ORDER BY created_at LIMIT 1), \${process.env.MEDIA_SLUG})
        RETURNING id::text AS id\`;
      out.media = media[0].id;
      const ci = await tx\`INSERT INTO content_instances (module_id, "values") VALUES (\${mod[0].id}::uuid, \${values}::text::jsonb) RETURNING id::text AS id\`;
      out.ci = ci[0].id;
      for (const [key, slug] of [["pg", process.env.PAGE_SLUG], ["twin", process.env.TWIN_SLUG]]) {
        const pg = await tx\`
          INSERT INTO pages (slug, title, template_id, status)
          VALUES (\${slug}, 'LE Shared', \${tpl[0].id}::uuid, 'draft')
          RETURNING id::text AS id\`;
        out[key] = pg[0].id;
        await tx\`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode) VALUES (\${pg[0].id}::uuid, 'content', 0, \${mod[0].id}::uuid, \${ci[0].id}::uuid, 'synced')\`;
      }
    });
    await sql.end();
    process.stdout.write(JSON.stringify(out));
    `,
    { TPL_SLUG, MOD_SLUG, PAGE_SLUG, TWIN_SLUG, MEDIA_SLUG },
  );
  const ids = JSON.parse(seed) as { pg: string; twin: string; ci: string; media: string };

  // The media library, as the picker lists it.
  await page.route(/\/api\/media\/list/, (route) =>
    route.fulfill({
      json: {
        assets: [
          {
            id: ids.media,
            slug: MEDIA_SLUG,
            mime: "image/png",
            originalName: "e2e-cup.png",
            width: 1,
            height: 1,
            alt: "A blue cup",
            variants: [{ variant: "orig" }],
          },
        ],
      },
    }),
  );

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
  // #1081 — a chat of this spec's own: without `chat=`, Live Edit resumes
  // dev-owner's most recent chat, which a parallel spec may have opened on
  // an experiment branch or be running a turn in.
  chat = openOwnerChat(`e2e-le-shared-${ts}`);
  await page.goto(`/edit?page=${ids.pg}&chat=${chat}`);

  const preview = page.frameLocator("iframe[title='Live preview']");
  const card = preview.locator("section[data-caelo-module-id]");
  await expect(card.locator("h1")).toHaveText("SHARED_TITLE", { timeout: 15_000 });
  const save = () => page.waitForResponse((r) => r.url().includes("editFields"));

  // 1. Link text + target in one save; shared on 2 pages → "everywhere".
  await card.locator("nav a").click({ button: "right", position: { x: 4, y: 4 } });
  await preview.getByTestId("caelo-menu-edit-link").click();
  await preview.getByTestId("caelo-link-text").fill("Handbook");
  await preview.getByTestId("caelo-link-href").fill(`/${TWIN_SLUG}`);
  await preview.getByTestId("caelo-link-save").click();
  await expect(preview.getByTestId("caelo-scope")).toContainText("2 pages");
  let saved = save();
  await preview.getByTestId("caelo-scope-everywhere").click();
  expect((await saved).ok()).toBe(true);
  await expect(card.locator("nav a")).toHaveText("Handbook", { timeout: 15_000 });
  // Stored as a page reference (#724), rendered as the page's path.
  await expect(card.locator("nav a")).toHaveAttribute("href", `/${TWIN_SLUG}/`);
  expect(branchValues(ids.ci)?.links).toEqual([
    {
      id: "00000000-0000-4000-9000-000000000001",
      node: "link",
      values: { label: "Handbook", link: { href: `caelo:page/${ids.twin}` } },
    },
  ]);

  // 2. Shared title → "only on this page": this page detaches, the shared
  //    content keeps its title.
  await card.locator("h1").click({ button: "right", position: { x: 4, y: 4 } });
  await preview.getByTestId("caelo-menu-edit").click();
  await page.keyboard.type("Only here");
  await page.keyboard.press("Enter");
  saved = save();
  await preview.getByTestId("caelo-scope-here").click();
  expect((await saved).ok()).toBe(true);
  await expect(card.locator("h1")).toHaveText("Only here", { timeout: 15_000 });
  // The edited span shows the new text before the save lands; the preview
  // has reloaded with the stored state once that span is gone.
  await expect(preview.locator("[data-caelo-saving]")).toHaveCount(0, { timeout: 15_000 });
  expect(branchValues(ids.ci)?.title).toBe("SHARED_TITLE");

  // 3. Replace image: no scope question any more (detached), picker → save.
  await card.locator("img").click({ button: "right", position: { x: 4, y: 4 } });
  await preview.getByTestId("caelo-menu-replace-image").click();
  await page.getByTitle(/e2e-cup\.png/).click();
  saved = save();
  expect((await saved).ok()).toBe(true);
  await expect(card.locator("img")).toHaveAttribute("src", /e2e-cup/, { timeout: 15_000 });
  await expect(card.locator("img")).toHaveAttribute("alt", "A blue cup");
});
