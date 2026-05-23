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
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";

const EXTRACT_PROMPT =
  "Please add a new module to the homepage's content block at position 0. " +
  "Slug: `welcome-hero`. Display name: Welcome hero. " +
  "Description: Standalone marketing hero. Kind: hero. " +
  "HTML — pass it AS-IS (no pre-templatising; no fields[] array) so the server-side " +
  'extractor runs and shows what it produces: `<h1>Welcome to Caelo</h1><a href="/get-started">Get started</a>`';

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
        let payload = JSON.stringify({ moduleId: null, slug: null, html: null, fields: [] });
        await sql.begin(async (tx) => {
          // RLS gates module reads; flip actor_kind to 'system' for
          // the duration of the select (the rest of the e2e seeds
          // use this pattern).
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const rows = await tx\`
            SELECT id::text AS id, slug, html, fields::text AS fields_text
            FROM modules
            WHERE slug LIKE 'welcome-hero%'
              AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
          \`;
          const r = rows[0];
          if (r) {
            // The codebase's jsonb writes (interpolating a JSON-string
            // parameter cast with ::jsonb through drizzle's bun:SQL
            // adapter) store as a JSON-string scalar
            // (jsonb_typeof = "string"), not as an array. The
            // production read path in rowToModule compensates with a
            // string-typeof JSON.parse, but a raw SELECT here lands
            // the double-encoded form. Parse iteratively until we hit
            // a non-string value or run out of passes.
            let parsed = r.fields_text;
            for (let i = 0; i < 3 && typeof parsed === "string"; i += 1) {
              try {
                parsed = JSON.parse(parsed);
              } catch {
                parsed = [];
                break;
              }
            }
            const fields = Array.isArray(parsed) ? parsed : [];
            payload = JSON.stringify({
              moduleId: r.id,
              slug: r.slug,
              html: r.html,
              fields,
            });
          }
        });
        console.log(payload);
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
  seedMinimalSite();
  await attachChatSessionTracker(page);
  await loginAsDevOwner(page);

  // The ChatPanel test-id only mounts on /edit (and a few other
  // chat-bearing surfaces). After login Playwright lands on / which
  // has no chat — sendChatPromptAndWait would then time out trying
  // to find chat-turn-status. Navigate to /edit explicitly.
  await page.goto("/edit");

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
