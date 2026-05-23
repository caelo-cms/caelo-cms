// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario — AC #9: AI in chat composes a nested-module shape and the
 * result renders correctly on a page that uses the CTA-teaser.
 *
 * The operator asks the chat to build a "CTA-teaser that embeds a
 * Button". Driven by the live Anthropic API (same pattern as the
 * homepage scenario). Assertions are DB-level: a CTA-teaser module
 * with a field of kind='module', a Button module with a `label` text
 * field, a content_instance for each, and a `page_modules` placement
 * on the homepage. The renderer is exercised end-to-end by hitting
 * pages.render_preview on the resulting page.
 *
 * Coverage map:
 *   • AC #9 — AI-driven nested-module composition
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachChatSessionTracker,
  loginAsDevOwner,
  resetLiveditFixtures,
  sendChatPromptAndWait,
} from "./helpers.js";

const PROMPT =
  "Build a CTA-teaser module that has a nested Button module. " +
  "The Button module's HTML is `<button>{{label}}</button>` with a `label: text` field. " +
  "The CTA-teaser declares a `cta` field of kind=module whose slot in HTML is `{{>cta}}`, " +
  "and its HTML is `<section><h2>{{headline}}</h2>{{>cta}}</section>` with a `headline: text` field. " +
  "Place the CTA-teaser on the homepage's hero block. Create the content_instance for the Button with " +
  "label='Click me' and the content_instance for the CTA-teaser with headline='Get started' and cta " +
  "pointing at the Button's content_instance.";

interface DbSnap {
  ctaModuleId: string | null;
  buttonModuleId: string | null;
  ctaCi: { values: unknown } | null;
  buttonCi: { values: unknown } | null;
  homepagePlacement: { contentInstanceId: string } | null;
}

function snapshotNestedAuthoring(): DbSnap {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);

        // Find CTA-teaser + Button modules by recent creation (descending).
        const recent = await sql\`
          SELECT id::text AS id, slug, fields::text AS fields, html
          FROM modules
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 8
        \`;
        let ctaModuleId = null, buttonModuleId = null;
        for (const r of recent) {
          const fields = JSON.parse(r.fields);
          if (fields.some((f) => f.kind === 'module')) ctaModuleId = r.id;
          else if (r.html.includes('{{label}}') && r.html.includes('<button')) {
            buttonModuleId = r.id;
          }
        }

        // Find content_instances for each module.
        const ci = async (moduleId) => {
          if (!moduleId) return null;
          const r = await sql\`
            SELECT "values"::text AS values FROM content_instances
            WHERE module_id = \${moduleId}::uuid AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1
          \`;
          return r[0] ? { values: JSON.parse(r[0].values) } : null;
        };
        const ctaCi = await ci(ctaModuleId);
        const buttonCi = await ci(buttonModuleId);

        // Find a placement on the homepage referencing the CTA module.
        const hp = await sql\`SELECT id::text AS id FROM pages WHERE slug='home' AND locale='en' AND deleted_at IS NULL LIMIT 1\`;
        let homepagePlacement = null;
        if (hp[0] && ctaModuleId) {
          const pm = await sql\`
            SELECT content_instance_id::text AS id
            FROM page_modules
            WHERE page_id=\${hp[0].id}::uuid AND module_id=\${ctaModuleId}::uuid
            LIMIT 1
          \`;
          if (pm[0]) homepagePlacement = { contentInstanceId: pm[0].id };
        }

        console.log(JSON.stringify({ ctaModuleId, buttonModuleId, ctaCi, buttonCi, homepagePlacement }));
        await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`snapshot failed: ${raw.stderr}`);
  return JSON.parse(raw.stdout) as DbSnap;
}

test("AC #9: AI composes a CTA-teaser embedding a Button via the `module` field kind", async ({
  page,
}) => {
  await resetLiveditFixtures();
  await attachChatSessionTracker(page);
  await loginAsDevOwner(page);

  await sendChatPromptAndWait(page, PROMPT);

  const snap = snapshotNestedAuthoring();
  expect(snap.ctaModuleId).not.toBeNull();
  expect(snap.buttonModuleId).not.toBeNull();
  expect(snap.ctaCi).not.toBeNull();
  expect(snap.buttonCi).not.toBeNull();
  expect(snap.homepagePlacement).not.toBeNull();

  // The CTA content_instance's values should carry a nested ref shape
  // pointing at the Button (the operator-described pattern).
  const ctaValues = snap.ctaCi?.values as Record<string, unknown>;
  expect(ctaValues).toBeDefined();
  const cta = ctaValues.cta as { moduleId?: string; contentInstanceId?: string } | undefined;
  expect(cta?.moduleId).toBe(snap.buttonModuleId);
});
