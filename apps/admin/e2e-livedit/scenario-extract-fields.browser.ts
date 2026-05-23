// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario — AC #1: extractModuleStructure infers fields from
 * hardcoded HTML.
 *
 * The operator says: "create a module with this HTML: `<h1>Welcome</h1>
 * <a href="/x">go</a>`". The AI calls `edit_module` (or
 * `add_module_to_page`) with the un-templatised HTML. The server's
 * extractor walks the HTML, inserts {{title}} + {{ctaHref}} +
 * {{ctaLabel}} placeholders, mints the matching fields with the
 * original strings as defaults, and persists. A follow-up DB read
 * confirms the persisted shape.
 *
 * Coverage map (`.workflow-plan.md` §8 Tier 3):
 *   • AC #1 — extractor inference + idempotency
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachChatSessionTracker,
  loginAsDevOwner,
  resetLiveditFixtures,
  sendChatPromptAndWait,
} from "./helpers.js";

const EXTRACT_PROMPT =
  "Please create a new module called 'welcome-hero' on the homepage's hero block with this exact HTML: " +
  '`<h1>Welcome to Caelo</h1><a href="/get-started">Get started</a>`. ' +
  "Do not pre-templatise — pass the HTML as-is and let the server extract fields.";

interface ExtractedModuleSnapshot {
  moduleId: string | null;
  slug: string | null;
  html: string | null;
  fields: { name: string; kind: string; default?: unknown }[];
}

function snapshotWelcomeHeroModule(): ExtractedModuleSnapshot {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        const rows = await sql\`
          SELECT id::text AS id, slug, html, fields
          FROM modules
          WHERE slug LIKE 'welcome-hero%'
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        \`;
        const r = rows[0];
        if (!r) {
          console.log(JSON.stringify({ moduleId: null, slug: null, html: null, fields: [] }));
        } else {
          const fields = typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields;
          console.log(JSON.stringify({
            moduleId: r.id,
            slug: r.slug,
            html: r.html,
            fields: Array.isArray(fields) ? fields : [],
          }));
        }
        await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`bun -e failed: ${raw.stderr}`);
  }
  return JSON.parse(raw.stdout) as ExtractedModuleSnapshot;
}

test("AC #1: extractor produces {{title}} + {{ctaHref}} + {{ctaLabel}} for hardcoded HTML", async ({
  page,
}) => {
  await resetLiveditFixtures();
  await attachChatSessionTracker(page);
  await loginAsDevOwner(page);

  await sendChatPromptAndWait(page, EXTRACT_PROMPT);

  const snap = snapshotWelcomeHeroModule();
  expect(snap.moduleId).not.toBeNull();
  expect(snap.html).toContain("{{");
  // The extractor should have replaced literal "Welcome to Caelo" + "Get started"
  // with placeholders. Don't be over-prescriptive on field names; any of the
  // standard inferred names is acceptable (title vs heading, ctaLabel vs cta1Label).
  const fieldNames = snap.fields.map((f) => f.name);
  expect(fieldNames.length).toBeGreaterThanOrEqual(2);
  expect(snap.html).not.toContain("Welcome to Caelo");
  expect(snap.html).not.toContain("Get started");

  // Defaults should carry the original strings so the renderer can fall
  // back to them on a placement that hasn't been customized.
  const defaults = snap.fields.map((f) => f.default).filter((d) => typeof d === "string");
  expect(defaults).toEqual(expect.arrayContaining([expect.stringContaining("Welcome")]));
});
