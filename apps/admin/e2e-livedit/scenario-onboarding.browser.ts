// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #200, epic #186) — onboarding entry routing.
 *
 * The epic's front-door promise: a fresh install greets the operator
 * in /edit BEFORE they type anything, and a first message naming an
 * existing website routes into the MIGRATION flow — inspect first,
 * propose the Owner-gated crawl, and never claim the crawl ran.
 *
 * Regression classes this catches (mock-AI cannot):
 *   - the welcome seed silently not firing on untouched installs;
 *   - routing text drifting out of the cold-start prompt so a domain
 *     message gets a from-memory rebuild instead of a migration;
 *   - the AI claiming the gated crawl already ran (§11.A violation).
 *
 * OPT-IN: CAELO_LIVEDIT_ONBOARDING=1 (multi-tool migration turns are
 * nightly/on-demand cost, not per-PR).
 */

import { spawnSync } from "node:child_process";
import { startMigrateFixtureSite } from "./fixtures/migrate-site.js";
import { expect, test } from "./fixtures.js";
import { loginAsDevOwner, resetLiveditFixtures, sendChatPromptAndWait } from "./helpers.js";

function dbJson<T>(script: string): T {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let out = null;
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          out = await (async () => { ${script} })();
        });
        await sql.end();
        process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`dbJson failed: ${raw.stderr || raw.stdout}`);
  return JSON.parse(raw.stdout.trim()) as T;
}

/** Untouched-install reset: content wiped + identity cleared + no
 *  leftover import runs (the welcome seed keys on all three). */
function resetToUntouchedInstall(): void {
  resetLiveditFixtures();
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await tx\`UPDATE site_defaults SET site_name = NULL, site_purpose = NULL, design_brief = NULL WHERE id = 1\`;
          await tx\`DELETE FROM import_pages\`;
          await tx\`DELETE FROM import_runs\`;
          await tx\`DELETE FROM genesis_drafts\`;
        });
        await sql.end();
      `,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new Error(`resetToUntouchedInstall failed: ${raw.stderr || raw.stdout}`);
  }
}

test.describe("e2e-livedit onboarding — welcome + migration routing", () => {
  test.skip(
    process.env.CAELO_LIVEDIT_ONBOARDING !== "1",
    "opt-in (CAELO_LIVEDIT_ONBOARDING=1) — multi-tool migration turns are nightly/on-demand cost",
  );

  test("fresh install greets first; a domain message becomes a crawl PROPOSAL, never a claimed crawl", async ({
    page,
  }) => {
    resetToUntouchedInstall();
    const site = await startMigrateFixtureSite();
    try {
      await loginAsDevOwner(page);
      await page.goto("/edit");

      // ── The welcome is there BEFORE any operator input ───────────
      const transcript = page.locator("ul", { hasText: "Pick one of the options" }).first();
      await expect(transcript).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("You already have a website")).toBeVisible();

      // ── Operator answers with their existing site ────────────────
      await sendChatPromptAndWait(
        page,
        `Meine bestehende Website ist ${site.url} — bitte übernehmt sie in Caelo, das Design soll erhalten bleiben.`,
      );

      // ── The AI LOOKED at the site before proposing ───────────────
      const inspected = dbJson<{ n: number }[]>(`
        return await tx\`
          SELECT count(*)::int AS n FROM chat_messages
          WHERE role = 'assistant' AND tool_calls::text LIKE '%inspect_external_page%'
        \`;
      `);
      expect(
        inspected[0]?.n ?? 0,
        "the migration flow must inspect the real site before the fork/proposal",
      ).toBeGreaterThanOrEqual(1);

      // ── A crawl PROPOSAL exists — and nothing beyond 'proposed' ──
      const runs = dbJson<{ status: string; source_url: string; estimate: unknown }[]>(`
        return await tx\`SELECT status, source_url, estimate FROM import_runs\`;
      `);
      expect(runs.length, "exactly one crawl proposal should be queued").toBe(1);
      expect(runs[0]?.source_url).toContain("127.0.0.1");
      expect(
        runs[0]?.status,
        "§11.A: the AI proposes; only the Owner's click moves the run past 'proposed'",
      ).toBe("proposed");
      expect(runs[0]?.estimate, "the proposal carries the #193 scope estimate").not.toBeNull();

      // ── The AI surfaces the crawl as a PROPOSAL for the Owner to approve,
      // and must NOT claim it already crawled. Post the SDK-native approval
      // gate, the proposal renders as an INLINE Approve/Reject card in the
      // chat — the pre-gate "/security/import/pending" link is gone. (The DB
      // assertions above already prove status='proposed'; this guards the
      // transcript wording.)
      const body = (await page.locator("body").innerText()).toLowerCase();
      expect(body, "the AI offers the crawl for the Owner to approve").toMatch(
        /approve|freigeb|genehmig|queued|angesto/,
      );
      expect(body, "the AI must NOT claim it already crawled").not.toMatch(
        /crawl (abgeschlossen|complete|done|fertig)|habe .* gecrawlt/,
      );
    } finally {
      site.stop();
    }
  });
});
