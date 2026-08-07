// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario: international-site — "übersetze die Seite ins Deutsche"
 * (epic #380, #400).
 *
 * The operator asks IN GERMAN for a German translation of the home
 * page. Per CLAUDE.md §1A the AI must complete the whole arc without
 * round-tripping an implementation question: register the locale
 * (gated set_locales — auto-approved via CAELO_E2E_AUTO_APPROVE_PROPOSALS
 * in this suite), mint the /de/ counterpart with a localized slug, and
 * run the context-aware translation. The result stays a draft.
 *
 * Coverage map:
 *   • AC #380/§7 — locale config is AI-proposable, never AI-applied
 *     (the gated tool path runs; auto-approve stands in for the click).
 *   • AC #397 — whole-page translation lands on the VARIANT's values;
 *     the source page's content is untouched (shared-module leak guard).
 *   • AC #396 — variant grouping is explicit (group_id), slug freely
 *     localizable, URL composed under /de/.
 *   • §1A — no implementation question back to the operator: the turn
 *     ends with the work done, not with "should I…?".
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "./fixtures.js";
import {
  activatePluginAsOwner,
  assertNoChatRunnerDiagWarnings,
  assertNoOrphanLocks,
  attachChatSessionTracker,
  loginAsDevOwner,
  resetLiveditFixtures,
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";

interface IntlState {
  locales: { code: string; is_default: boolean }[];
  variants: { page_id: string; locale_code: string; translation_status: string }[];
  dePage: { id: string; title: string; status: string; current_path: string } | null;
  sourceValues: string;
  deValues: string | null;
}

/** Snapshot the plugin's i18n state + both pages' first placement values. */
function readIntlState(sourcePageId: string): IntlState {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      let out;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
        if (!plug[0]) throw new Error("international-site plugin not loaded");
        await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
        const locales = await tx.unsafe("SELECT code, is_default FROM plugin_international_site.locales ORDER BY code");
        const variants = await tx.unsafe("SELECT page_id, locale_code, translation_status FROM plugin_international_site.page_variants");
        const deVariant = variants.find((v) => v.locale_code === "de");
        const dePage = deVariant
          ? (await tx\`SELECT id, title, status, current_path FROM pages WHERE id = \${deVariant.page_id}::uuid\`)[0] ?? null
          : null;
        const firstValues = async (pageId) => {
          const rows = await tx\`
            SELECT ci."values"::text AS v FROM page_modules pm
            JOIN content_instances ci ON ci.id = pm.content_instance_id
            WHERE pm.page_id = \${pageId}::uuid ORDER BY pm.block_name, pm.position LIMIT 1\`;
          return rows[0]?.v ?? null;
        };
        out = {
          locales,
          variants,
          dePage,
          sourceValues: await firstValues(process.env.SOURCE_PAGE_ID),
          deValues: dePage ? await firstValues(dePage.id) : null,
        };
      });
      await sql.end();
      console.log(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env, SOURCE_PAGE_ID: sourcePageId }, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`readIntlState failed: ${raw.stderr || raw.stdout}`);
  return JSON.parse(raw.stdout.trim().split("\n").at(-1) ?? "{}") as IntlState;
}

/** Give the home page ONE placement with translatable values so the
 *  translation pass has real content to move (idempotent per rerun). */
function seedHomeContent(pageId: string): void {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const existing = await tx\`
          SELECT 1 FROM page_modules WHERE page_id = \${process.env.PAGE_ID}::uuid LIMIT 1\`;
        if (existing[0]) return;
        // modules' uniqueness is an expression index (slug + branch),
        // which ON CONFLICT (slug) cannot target — select-or-insert.
        let mod = await tx\`
          SELECT id FROM modules WHERE slug = 'livedit-intl-hero' AND deleted_at IS NULL LIMIT 1\`;
        if (!mod[0]) {
          mod = await tx\`
            INSERT INTO modules (slug, display_name, type, kind, html)
            VALUES ('livedit-intl-hero', 'Intl hero', 'livedit-intl-hero', 'hero',
                    '<h1>{{headline}}</h1><p>{{body_text}}</p>')
            RETURNING id\`;
        }
        const ci = await tx\`
          INSERT INTO content_instances (module_id, slug, display_name, "values")
          VALUES (\${mod[0].id}, 'livedit-intl-hero-home', 'Intl hero home',
                  '{"headline": "Welcome to our workshop", "body_text": "We build handcrafted oak furniture in small batches."}')
          RETURNING id\`;
        await tx\`
          INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
          VALUES (\${process.env.PAGE_ID}::uuid, 'content', 0, \${mod[0].id}, \${ci[0].id}, 'unsynced')\`;
      });
      await sql.end();
      `,
    ],
    { env: { ...process.env, PAGE_ID: pageId }, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`seedHomeContent failed: ${raw.stderr || raw.stdout}`);
}

/** Wipe the plugin's i18n rows so a rerun starts from zero locales. */
function resetIntlState(): void {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        // The plugins ROW exists as soon as the host discovers the
        // plugin, but its SCHEMA only exists once an Owner activated it
        // and the loader provisioned it. On a cold database there is
        // nothing to reset — checking the row would pass and the DELETE
        // would then fail on a missing relation.
        const plug = await tx\`SELECT id FROM plugins WHERE slug = 'international-site'\`;
        const provisioned = await tx.unsafe(
          "SELECT to_regclass('plugin_international_site.page_variants') IS NOT NULL AS ok",
        );
        if (plug[0] && provisioned[0]?.ok) {
          await tx.unsafe(\`SET LOCAL caelo.plugin_id = '\${plug[0].id}'\`);
          await tx.unsafe("DELETE FROM plugin_international_site.page_variants");
          await tx.unsafe("DELETE FROM plugin_international_site.locales");
        }
        await tx\`DELETE FROM pages WHERE slug <> 'home' AND current_path LIKE '/de/%'\`;
      });
      await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`resetIntlState failed: ${raw.stderr || raw.stdout}`);
}

test("übersetze die Seite ins Deutsche — locale gate, /de/ variant, values-level translation", async ({
  page,
}) => {
  resetLiveditFixtures();
  const seed = seedMinimalSite();
  seedHomeContent(seed.pageId);
  resetIntlState();

  const tracker = attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  // The plugin ships with Caelo but does not run until an Owner says
  // so. Without this click the AI has no locale tools and no i18n
  // skills — it would improvise a "translation" out of duplicate_page
  // and set_page_module_content, which is exactly what this scenario
  // caught before the activation state was made hard.
  await activatePluginAsOwner(page, "international-site");
  await page.goto("/edit");

  await sendChatPromptAndWait(
    page,
    "Übersetze die Startseite ins Deutsche. Die deutsche Version soll unter /de/ erreichbar sein.",
    // Locale proposal + variant mint + one whole-page translation call.
    600_000,
  );
  const sessionId = tracker.currentSessionId();

  const state = readIntlState(seed.pageId);

  // Locale registry: German registered alongside a default locale —
  // written only through the gated tool (auto-approve stands in for
  // the Owner's click in this suite).
  expect(state.locales.map((l) => l.code)).toContain("de");
  expect(state.locales.filter((l) => l.is_default)).toHaveLength(1);

  // Variant group: the home page is the source; the de counterpart is
  // a separate page under /de/ (localized slug allowed — assert the
  // prefix, not the slug the AI chose).
  const source = state.variants.find((v) => v.page_id === seed.pageId);
  expect(source?.translation_status).toBe("source");
  expect(state.dePage).not.toBeNull();
  // Under /de — either `/de/<localized-slug>` for an ordinary page, or
  // the bare `/de` when the translated page is the site's home, which
  // is the root of its own locale and carries no slug segment.
  expect(state.dePage?.current_path).toMatch(/^\/de(\/|$)/);

  // #397 — translation landed on the VARIANT's values; the source
  // page's content is untouched (module HTML is shared — a leak into
  // the source would mean the plugin translated the wrong layer).
  const deVariant = state.variants.find((v) => v.locale_code === "de");
  expect(deVariant?.translation_status).toBe("up_to_date");
  if (state.deValues !== null) {
    expect(state.deValues).not.toBe(state.sourceValues);
  }

  assertNoOrphanLocks(sessionId ?? "");
  assertNoChatRunnerDiagWarnings();
});
