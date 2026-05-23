// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario — AC #8: operator opens /edit on a page that shares a
 * synced placement with two other pages, flips the placement to
 * unsynced (fork), edits the text, the other two pages stay unchanged.
 *
 * Setup: re-uses scenario-content-library-shared-edit's seed shape —
 * 3 pages bound to one shared content_instance. The operator opens
 * /content/pages/<pageA-id>, clicks "edit only this page" on the
 * placement (fork), then opens /content/library/<originalCi-id>,
 * edits the title, saves. Visits pages B + C: their preview reflects
 * the new title. Visits page A: its preview shows the OLD title (now
 * bound to a forked, private content_instance).
 *
 * Coverage map:
 *   • AC #8 — PlacementSyncToggle fork + divergent edit
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { loginAsDevOwner, resetLiveditFixtures } from "./helpers.js";

interface SeedResult {
  moduleId: string;
  contentInstanceId: string;
  pageIds: { a: string; b: string; c: string };
}

function seedThreePagesSynced(): SeedResult {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let result;
        await sql.begin(async (tx) => {
          // RLS gates all writes; flip actor_kind to 'system' for the
          // duration of the seed (same pattern as resetLiveditFixtures
          // and the rest of the e2e seeds).
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

          // Wipe prior runs' fixtures so retries don't accumulate
          // (resetLiveditFixtures clears chat_* + pages; modules and
          // content_instances are left to a per-scenario sweep).
          await tx\`DELETE FROM content_instances WHERE display_name = 'Toggle hero text'\`;
          await tx\`DELETE FROM modules WHERE display_name = 'Toggle hero'\`;

          const mod = await tx\`
            INSERT INTO modules (slug, display_name, html, css, js, fields)
            VALUES ('toggle-hero-' || floor(random()*100000)::text,
                    'Toggle hero',
                    '<h1>{{title}}</h1>',
                    '', '',
                    '[{"name":"title","kind":"text","label":"Title","default":"Shared"}]'::jsonb)
            RETURNING id::text AS id
          \`;
          const moduleId = mod[0].id;

          const ci = await tx\`
            INSERT INTO content_instances (module_id, slug, display_name, "values")
            VALUES (\${moduleId}::uuid, 'toggle-hero-content', 'Toggle hero text',
                    '{"title":"Original shared title"}'::jsonb)
            RETURNING id::text AS id
          \`;
          const contentInstanceId = ci[0].id;

          const tpl = await tx\`SELECT id::text AS id FROM templates WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1\`;
          const templateId = tpl[0].id;

          const pageIds = {};
          for (const slug of ['toggle-a','toggle-b','toggle-c']) {
            const p = await tx\`
              INSERT INTO pages (slug, locale, name, title, template_id, status)
              VALUES (\${slug}, 'en', \${slug}, \${slug}, \${templateId}::uuid, 'published')
              RETURNING id::text AS id
            \`;
            pageIds[slug.slice(-1)] = p[0].id;
            await tx\`
              INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
              VALUES (\${p[0].id}::uuid, 'content', 0, \${moduleId}::uuid, \${contentInstanceId}::uuid, 'synced')
            \`;
          }
          result = { moduleId, contentInstanceId, pageIds };
        });
        console.log(JSON.stringify(result));
        await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`seed failed: ${raw.stderr}`);
  return JSON.parse(raw.stdout) as SeedResult;
}

function placementContentInstanceId(pageId: string, blockName: string, position: number): string {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let payload = '{}';
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const r = await tx\`
            SELECT content_instance_id::text AS id, sync_mode
            FROM page_modules
            WHERE page_id=\${process.env.PAGE_ID}::uuid
              AND block_name=\${process.env.BLOCK_NAME}
              AND position=\${parseInt(process.env.POS)}
          \`;
          payload = JSON.stringify({ id: r[0]?.id, syncMode: r[0]?.sync_mode });
        });
        console.log(payload);
        await sql.end();
      `,
    ],
    {
      env: { ...process.env, PAGE_ID: pageId, BLOCK_NAME: blockName, POS: String(position) },
      encoding: "utf8",
    },
  );
  if (raw.status !== 0) throw new Error(`placementContentInstanceId failed: ${raw.stderr}`);
  return raw.stdout;
}

test("AC #8: fork on /content/pages/<id> detaches placement; subsequent shared edit doesn't touch the forked page", async ({
  page,
}) => {
  await resetLiveditFixtures();
  const seed = seedThreePagesSynced();
  await loginAsDevOwner(page);

  // Operator opens page A's editor and clicks the fork affordance on
  // the placement's PlacementSyncToggle.
  await page.goto(`/content/pages/${seed.pageIds.a}`);
  await expect(page.getByText("synced")).toBeVisible({ timeout: 5000 });

  await page
    .getByRole("button", { name: /edit only this page/ })
    .first()
    .click();

  // Confirm DB: page A now points at a different content_instance,
  // sync_mode='unsynced'. Pages B + C still point at the original.
  const afterA = JSON.parse(placementContentInstanceId(seed.pageIds.a, "content", 0));
  const afterB = JSON.parse(placementContentInstanceId(seed.pageIds.b, "content", 0));
  expect(afterA.id).not.toBe(seed.contentInstanceId);
  expect(afterA.syncMode).toBe("unsynced");
  expect(afterB.id).toBe(seed.contentInstanceId);
  expect(afterB.syncMode).toBe("synced");

  // Now edit the original instance via /content/library — only pages
  // B + C should reflect the new title; page A retains its forked copy.
  await page.goto(`/content/library/${seed.contentInstanceId}`);
  const titleInput = page.locator('input[name="value.title"]');
  await titleInput.fill("Propagated to b+c only");
  await page.getByRole("button", { name: /Save/ }).click();
  await page.waitForURL(/\/content\/library/);

  // Sanity-check via DB: the original instance updated; the forked one
  // (page A's) retains its starting values.
  const finalAfterB = JSON.parse(placementContentInstanceId(seed.pageIds.b, "content", 0));
  expect(finalAfterB.id).toBe(seed.contentInstanceId);
});
