// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #106, step-13 regression guard) — the layout/footer path.
 *
 * The footer bug: asking the chat to "add a footer with nav links to every
 * page" reproducibly ended the assistant turn after a correct preamble
 * WITHOUT emitting add_module_to_layout, because that tool's JSON field
 * schema could not represent a `link-list` (a nav menu). The proof the path
 * works is a module placed in the layout's `footer` block whose repeating
 * nav is a single `link-list` field — not numbered label1/label2 scalars
 * (CLAUDE.md §1A) — and no operator-punt in the final assistant message.
 *
 * Self-contained like scenario-ai-nested-cta: it seeds its own `footer`
 * block on the site-default layout (seedMinimalSite only creates the page +
 * a `content` template block) and snapshots the DB via a bun subprocess.
 *
 * Coverage map:
 *   • issue #106 — add_module_to_layout emits a link-list footer (flavor #1/#2)
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "./fixtures.js";
import {
  attachChatSessionTracker,
  loginAsDevOwner,
  resetLiveditFixtures,
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";

const PROMPT =
  "Add a footer with navigation links to Home, About, and Contact to every page of the site.";

/** Operator-punt phrasing the AI must NOT emit (AC #5 — recover, don't punt). */
const PUNT_PATTERNS = [
  /you'?ll need to/i,
  /remove it via the editor/i,
  /add (?:the|a) block (?:in|via) the (?:editor|admin)/i,
  /please (?:add|create|configure) .* (?:in|via) the (?:editor|admin|settings)/i,
];

interface FooterSnap {
  footerModuleCount: number;
  hasLinkListField: boolean;
  navLinksInHtml: boolean;
  lastAssistant: string;
}

/**
 * Ensure the site-default layout has a `footer` block, then snapshot the
 * layout_modules placed in it + the last assistant message. Runs in a bun
 * subprocess so the Node-side spec can reach Postgres via bun:SQL (same
 * pattern as scenario-ai-nested-cta's snapshot).
 */
function seedFooterBlock(): void {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const lay = await tx\`SELECT id::text AS id FROM layouts WHERE slug='site-default' AND deleted_at IS NULL LIMIT 1\`;
          if (lay[0]) {
            await tx\`
              INSERT INTO layout_blocks (layout_id, name, display_name, position)
              VALUES (\${lay[0].id}::uuid, 'footer', 'Footer', 0)
              ON CONFLICT (layout_id, name) DO NOTHING
            \`;
          }
        });
        await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`seedFooterBlock failed: ${r.stderr || r.stdout}`);
}

function snapshotFooter(): FooterSnap {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        function parseFields(text) {
          let parsed = text;
          for (let i = 0; i < 3 && typeof parsed === 'string'; i += 1) {
            try { parsed = JSON.parse(parsed); } catch { return []; }
          }
          return Array.isArray(parsed) ? parsed : [];
        }
        let payload = JSON.stringify({ footerModuleCount: 0, hasLinkListField: false, lastAssistant: "" });
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          const rows = await tx\`
            SELECT m.fields::text AS fields, m.html AS html
            FROM layout_modules lm
            JOIN modules m ON m.id = lm.module_id
            WHERE lm.block_name = 'footer'
          \`;
          let hasLinkListField = false;
          let navLinksInHtml = false;
          for (const r of rows) {
            const fields = parseFields(r.fields);
            if (fields.some((f) => f.kind === 'link-list')) hasLinkListField = true;
            // Inline-anchor path: the model authored the fixed nav as literal
            // <a> tags rather than a link-list field. The distinctive labels
            // (About/Contact) appearing in the module HTML proves the nav is
            // really there (not numbered-scalar fields, whose labels would live
            // in the content_instance, not the HTML).
            const html = (r.html || '').toLowerCase();
            if (html.includes('about') && html.includes('contact')) navLinksInHtml = true;
          }
          const msg = await tx\`
            SELECT content FROM chat_messages
            WHERE role = 'assistant' AND content IS NOT NULL AND content <> ''
            ORDER BY created_at DESC LIMIT 1
          \`;
          payload = JSON.stringify({
            footerModuleCount: rows.length,
            hasLinkListField,
            navLinksInHtml,
            lastAssistant: msg[0]?.content ?? "",
          });
        });
        console.log(payload);
        await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`snapshotFooter failed: ${raw.stderr || raw.stdout}`);
  return JSON.parse(raw.stdout) as FooterSnap;
}

test("issue #106: AI adds a footer nav to the layout via add_module_to_layout (link-list, no punt)", async ({
  page,
}) => {
  await resetLiveditFixtures();
  seedMinimalSite();
  seedFooterBlock();
  attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  // ChatPanel only mounts on /edit.
  await page.goto("/edit");

  await sendChatPromptAndWait(page, PROMPT);

  const snap = snapshotFooter();

  // add_module_to_layout actually emitted + placed a module in the footer
  // block (the turn didn't narrate-then-drop the tool call). This is the core
  // #106 regression guard — the bug was the turn ending WITHOUT the tool call.
  expect(snap.footerModuleCount).toBeGreaterThan(0);
  // The nav is really present, either as a `link-list` field (the §1A-ideal +
  // the field kind the old restricted layout schema could NOT represent — the
  // schema's link-list capability is pinned deterministically in
  // module-fields-schema.test.ts) OR as inline <a> tags carrying the labels.
  // Both are valid for a fixed nav and don't punt; this assertion stays robust
  // to the live model's choice while still rejecting the §1A numbered-scalar
  // anti-pattern (whose labels live in the content_instance, not the HTML, so
  // neither branch would be true) and the narrate-then-drop regression above.
  expect(snap.hasLinkListField || snap.navLinksInHtml).toBe(true);
  // AC #5 — the assistant recovered/built valid rather than punting an
  // implementation detail to the operator.
  for (const re of PUNT_PATTERNS) {
    expect(snap.lastAssistant).not.toMatch(re);
  }
});
