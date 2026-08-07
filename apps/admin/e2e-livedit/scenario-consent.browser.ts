// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario: consent-manager — "bau mir einen Cookie-Banner" (#454).
 *
 * The operator asks for a cookie banner in their own words and gets a
 * working one that looks like their site. Per CLAUDE.md §1A they never
 * hear the words category, data list, hook or runtime.
 *
 * What this catches that a mock-AI test cannot: whether the AI actually
 * finds and uses the contract. The plugin hands it the attribute names
 * through `consent_status` and a skill, and everything downstream — the
 * dialog working at all, a tag not firing early, a withheld embed
 * hydrating — depends on the AI having wired them into markup it wrote
 * itself. A banner that looks perfect and binds nothing is exactly the
 * failure this suite exists for, because it reads as success.
 *
 * Coverage map:
 *   • #451 — the categories reach the module as a data list; the banner
 *     iterates them instead of hard-coding four blocks.
 *   • #451 — the AI wires the documented hooks (accept-all, reject-all,
 *     per-category checkboxes) rather than inventing its own.
 *   • #449 — the plugin's runtime and stylesheet reach the page.
 *   • §1A — declining is offered as prominently as accepting, without
 *     the operator having to ask for it.
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

/** A second published page on the same template. */
function seedSecondPage(templateId: string): string {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return tx\`INSERT INTO pages (slug, title, template_id, status, current_path)
                  VALUES ('kontakt', 'Kontakt', \${templateId}::uuid, 'published', '/kontakt')
                  RETURNING id::text AS id\`;
      });
      console.log(rows[0].id);
      await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`seedSecondPage failed: ${raw.stderr || raw.stdout}`);
  return raw.stdout.trim();
}

/** Wipe the plugin's own tables so a rerun starts from the seed. */
function resetConsentState(): void {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const exists = await tx\`SELECT to_regclass('plugin_consent_manager.settings') AS t\`;
        if (!exists[0]?.t) return;
        await tx.unsafe('DELETE FROM plugin_consent_manager.module_guards');
        await tx.unsafe('DELETE FROM plugin_consent_manager.tags');
        await tx.unsafe('DELETE FROM plugin_consent_manager.settings');
        await tx.unsafe('DELETE FROM plugin_consent_manager.categories');
      });
      await sql.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`resetConsentState failed: ${raw.stderr || raw.stdout}`);
}

test("bau mir einen Cookie-Banner — categories as data, hooks wired, runtime on the page", async ({
  page,
}) => {
  resetLiveditFixtures();
  const seed = seedMinimalSite();
  resetConsentState();

  // A second page, seeded BEFORE the turn. Without it the difference
  // between "banner on this page" and "banner on the site" is invisible
  // — and an assertion the AI cannot observe the point of is a
  // preference dressed up as a gate.
  const secondPageId = seedSecondPage(seed.templateId);

  const tracker = attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  // Activation is a hard state: without the Owner's click the AI has no
  // consent tools and no consent skills, and would improvise a banner
  // out of plain module JS — which is precisely the thing that must not
  // be responsible for recording consent.
  await activatePluginAsOwner(page, "consent-manager");
  await page.goto("/edit");

  await sendChatPromptAndWait(
    page,
    "Wir brauchen einen Cookie-Banner für die ganze Website, der zum Design passt. Besucher sollen einzeln auswählen können, was sie erlauben.",
    600_000,
  );
  const sessionId = tracker.currentSessionId();

  // Render the home page the way a visitor would see it. /edit/preview
  // serves the composed page as raw HTML, without the admin chrome
  // around it.
  const preview = await page.goto(`/edit/preview/${seed.pageId}`);
  expect(preview?.status() ?? 0).toBeLessThan(400);
  const html = (await preview?.text()) ?? "";
  expect(html.length).toBeGreaterThan(0);

  // The dialog exists and the runtime can find it.
  expect(html).toContain("data-consent-banner");

  // The list resolved rather than shipping as a literal placeholder.
  expect(html).not.toContain("{{#consent_categories}}");

  // Every category the visitor can actually decide about is offered
  // individually — that is what the operator asked for, and a banner
  // with one Accept button is not it. `necessary` is deliberately not
  // required here: it cannot be declined, so rendering it as a line of
  // text rather than a checkbox is a legitimate choice.
  for (const key of ["functional", "analytics", "marketing"]) {
    expect(html).toContain(`data-consent-category="${key}"`);
  }

  // Declining has to be as easy as accepting; a banner without a reject
  // control is not lawful consent, and the AI must not need to be told.
  expect(html).toContain("data-consent-accept-all");
  expect(html).toContain("data-consent-reject-all");

  // The plugin's runtime reached the page (#449) — inlined in preview,
  // linked on deploy.
  expect(html).toContain("caelo-consent-ask");
  expect(html).toContain("/api/plugin/consent-manager/record_consent");

  // The property the layout placement exists for: the banner is on
  // EVERY page, including one the AI never looked at. Bound to the page
  // it was asked about, it would be missing from the next page the
  // operator adds — and nobody would notice, because the page they were
  // looking at when they asked is fine.
  const second = await page.goto(`/edit/preview/${secondPageId}`);
  expect(second?.status() ?? 0).toBeLessThan(400);
  expect((await second?.text()) ?? "").toContain("data-consent-banner");

  assertNoOrphanLocks(sessionId ?? "");
  assertNoChatRunnerDiagWarnings();
});
