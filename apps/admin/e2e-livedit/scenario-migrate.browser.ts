// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #200, epic #186) — keep-design migration, end to
 * end: welcome → domain message → crawl proposal → Owner Approve →
 * worker crawl (sitemap-seeded, robots-aware) → clustering → build →
 * URL continuity → report.
 *
 * Structural assertions only (real-AI content varies):
 *   - the crawl reaches ready_for_review after ONE Owner click, and
 *     the sitemap-only landing page was found (#192);
 *   - the build turn composes real pages (≥5) bound to MORE THAN ONE
 *     template (#194/#195 — the one-template collapse is the epic's
 *     original sin);
 *   - old .html paths 301 to the new pages (#196);
 *   - the fixture's seeded typo or dead link surfaces in notes or the
 *     transcript (#197) — the "wir haben es besser gemacht" promise.
 *
 * OPT-IN: CAELO_LIVEDIT_MIGRATE=1 — this is the epic's most expensive
 * scenario (crawl + multi-turn build); nightly/on-demand only.
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
          await tx\`DELETE FROM redirects WHERE from_path LIKE '/blog/%' OR from_path LIKE '/produkte/%'\`;
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

/** Poll the DB until the run leaves 'crawling' (worker tick is 10s). */
async function waitForCrawlDone(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = dbJson<{ status: string }[]>(
      "return await tx`SELECT status FROM import_runs ORDER BY created_at DESC LIMIT 1`;",
    );
    const status = rows[0]?.status ?? "missing";
    if (status === "ready_for_review" || status === "failed") return status;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return "timeout";
}

test.describe("e2e-livedit migration — keep-design end to end", () => {
  test.skip(
    process.env.CAELO_LIVEDIT_MIGRATE !== "1",
    "opt-in (CAELO_LIVEDIT_MIGRATE=1) — crawl + multi-turn build is the epic's most expensive scenario",
  );

  test("crawl → approve → per-type build with redirects and findings", async ({ page }) => {
    // The heaviest flow: crawl (external-page rendering) + a per-type rebuild
    // that fans out to subagents (each rebuilding a page cluster). The turns
    // progress steadily (no hang); they just outrun the default 8-min/10-min
    // budgets. Give them realistic room.
    test.setTimeout(1_500_000);
    resetToUntouchedInstall();
    const site = await startMigrateFixtureSite();
    try {
      await loginAsDevOwner(page);
      await page.goto("/edit");
      await expect(page.getByText("Pick one of the options")).toBeVisible({ timeout: 20_000 });

      // Turn 1 — name the site, ask for keep-design migration.
      await sendChatPromptAndWait(
        page,
        `Meine bestehende Website ist ${site.url} — bitte übernehmt sie KOMPLETT in Caelo. Das Design soll erhalten bleiben. Ihr dürft direkt loslegen, sobald ich den Crawl freigegeben habe.`,
      );
      const proposed = dbJson<{ id: string; status: string }[]>(
        "return await tx`SELECT id::text AS id, status FROM import_runs ORDER BY created_at DESC LIMIT 1`;",
      );
      expect(proposed[0]?.status).toBe("proposed");

      // Owner click — the ONLY manual step the epic allows.
      await page.goto("/security/import/pending");
      await page.getByRole("button", { name: "Approve crawl" }).first().click();
      const crawlStatus = await waitForCrawlDone(180_000);
      expect(crawlStatus, "crawl must reach ready_for_review after the Approve click").toBe(
        "ready_for_review",
      );

      // #192 — the sitemap-only page was discovered.
      const hidden = dbJson<{ n: number }[]>(
        "return await tx`SELECT count(*)::int AS n FROM import_pages WHERE source_url LIKE '%versteckte-landingpage%'`;",
      );
      expect(hidden[0]?.n, "sitemap seeding must find the unlinked landing page").toBe(1);

      // Turn 2 — build. (The AI knows the flow from the site-migrate
      // skill; this message only hands back control.)
      await page.goto("/edit");
      await sendChatPromptAndWait(
        page,
        "Der Crawl ist freigegeben und fertig. Bitte baut die Seite jetzt wie besprochen fertig — Seitentypen bestätigen wir so, wie ihr sie gruppiert habt.",
        900_000, // per-type rebuild fan-out — the heavy turn
      );

      // Some builds take a second confirmation turn; nudge once if no
      // pages landed yet.
      const pagesAfterTurn2 = dbJson<{ n: number }[]>(
        "return await tx`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL`;",
      );
      if ((pagesAfterTurn2[0]?.n ?? 0) === 0) {
        await sendChatPromptAndWait(
          page,
          "Ja, die Gruppierung passt — bitte alle Seiten jetzt bauen.",
          900_000, // build fan-out
        );
      }

      // ── Structural floor ─────────────────────────────────────────
      const summary = dbJson<{
        pages: number;
        templates: number;
        redirects: { from_path: string; to_path: string }[];
        notes: number;
      }>(`
        const pages = await tx\`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL\`;
        const templates = await tx\`
          SELECT count(DISTINCT template_id)::int AS n FROM pages WHERE deleted_at IS NULL
        \`;
        const redirects = await tx\`
          SELECT from_path, to_path FROM redirects WHERE from_path LIKE '%.html'
        \`;
        const notes = await tx\`
          SELECT count(*)::int AS n FROM import_pages WHERE notes IS NOT NULL
        \`;
        return {
          pages: pages[0].n,
          templates: templates[0].n,
          redirects,
          notes: notes[0].n,
        };
      `);
      expect(summary.pages, "the migrated site must have real pages").toBeGreaterThanOrEqual(5);
      expect(
        summary.templates,
        "clustering must yield MORE THAN ONE template (#194/#195 — the one-template collapse)",
      ).toBeGreaterThanOrEqual(2);
      expect(
        summary.redirects.length,
        "old .html URLs must 301 to the new paths (#196)",
      ).toBeGreaterThanOrEqual(1);

      // #197 — the seeded typo/dead link surfaces somewhere the
      // operator sees: notes on the run, or named in the transcript.
      // A long build can consume the loop budget before the closing
      // report; asking for it is a natural operator turn (the skill
      // mandates report-on-done either way), so nudge ONCE before
      // judging.
      let transcript = await page.locator("ul").first().innerText();
      let findingSurfaced =
        summary.notes > 0 ||
        /addresse|impressum-alt|toter link|dead link|schreibfehler|typo/i.test(transcript);
      if (!findingSurfaced) {
        await sendChatPromptAndWait(
          page,
          "Super — was ist euch beim Übernehmen inhaltlich aufgefallen? Bitte den Abschlussbericht (Tippfehler, tote Links, Verbesserungen).",
        );
        transcript = await page.locator("ul").first().innerText();
        const notesAfter = dbJson<{ n: number }[]>(
          "return await tx`SELECT count(*)::int AS n FROM import_pages WHERE notes IS NOT NULL`;",
        );
        findingSurfaced =
          (notesAfter[0]?.n ?? 0) > 0 ||
          /addresse|impressum-alt|toter link|dead link|schreibfehler|typo/i.test(transcript);
      }
      expect(
        findingSurfaced,
        "the migration must surface the seeded typo or dead link (notes or closing report)",
      ).toBe(true);
    } finally {
      site.stop();
    }
  });
});
