// SPDX-License-Identifier: MPL-2.0
/**
 * Scenario (issue #200, epic #186) — onboarding entry routing.
 *
 * The epic's front-door promise: a fresh install greets the operator
 * in /edit BEFORE they type anything, and a first message naming an
 * existing website routes into the MIGRATION flow — inspect first, then
 * ASK THE DESIGN DIRECTION (staged flow 0178) before anything is
 * crawled or built, and never claim a crawl ran.
 *
 * Staged flow (0178): a domain message no longer triggers an immediate
 * crawl proposal. Turn 1 inspects the homepage, maps the page types, and
 * offers the 3-way design-direction choice (1:1 / refresh / optimize) —
 * WAITING for the operator's pick before proposing even the scoped
 * homepage import. So after one message there is NO import run yet.
 *
 * Regression classes this catches (mock-AI cannot):
 *   - the welcome seed silently not firing on untouched installs;
 *   - routing text drifting out of the cold-start prompt so a domain
 *     message gets a from-memory rebuild instead of a migration;
 *   - the staged flow regressing to a crawl-first proposal before the
 *     operator has picked a design direction;
 *   - the AI claiming a crawl already ran (§11.A violation).
 *
 * OPT-IN: CAELO_LIVEDIT_ONBOARDING=1 (multi-tool migration turns are
 * nightly/on-demand cost, not per-PR).
 */
import { spawnSync } from "node:child_process";
import { startMigrateFixtureSite } from "./fixtures/migrate-site.js";
import { expect, test } from "./fixtures.js";
import { loginAsDevOwner, resetLiveditFixtures, sendChatPromptAndWait } from "./helpers.js";
function dbJson(script) {
    const raw = spawnSync("bun", [
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
    ], { env: { ...process.env }, encoding: "utf8" });
    if (raw.status !== 0)
        throw new Error(`dbJson failed: ${raw.stderr || raw.stdout}`);
    return JSON.parse(raw.stdout.trim());
}
/** Untouched-install reset: content wiped + identity cleared + no
 *  leftover import runs (the welcome seed keys on all three). */
function resetToUntouchedInstall() {
    resetLiveditFixtures();
    const raw = spawnSync("bun", [
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
    ], { env: { ...process.env }, encoding: "utf8" });
    if (raw.status !== 0) {
        throw new Error(`resetToUntouchedInstall failed: ${raw.stderr || raw.stdout}`);
    }
}
test.describe("e2e-livedit onboarding — welcome + migration routing", () => {
    test.skip(process.env.CAELO_LIVEDIT_ONBOARDING !== "1", "opt-in (CAELO_LIVEDIT_ONBOARDING=1) — multi-tool migration turns are nightly/on-demand cost");
    test("fresh install greets first; a domain message inspects + asks the design direction, never a claimed crawl", async ({ page, }) => {
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
            await sendChatPromptAndWait(page, `Meine bestehende Website ist ${site.url} — bitte übernehmt sie in Caelo, das Design soll erhalten bleiben.`);
            // ── The AI LOOKED at the site before deciding anything ───────
            const inspected = dbJson(`
        return await tx\`
          SELECT count(*)::int AS n FROM chat_messages
          WHERE role = 'assistant' AND tool_calls::text LIKE '%inspect_external_page%'
        \`;
      `);
            expect(inspected[0]?.n ?? 0, "the migration flow must inspect the real site before it asks the design direction").toBeGreaterThanOrEqual(1);
            // ── Staged flow (0178): NO crawl proposed yet — the AI first asks
            // the design direction and WAITS for the operator's pick. A crawl
            // (import_runs row) before the pick is exactly the regression this
            // now guards.
            const runs = dbJson(`
        return await tx\`SELECT status FROM import_runs\`;
      `);
            expect(runs.length, "staged flow: no crawl is proposed before the operator picks a design direction").toBe(0);
            // ── The AI offered the 3-way DESIGN DIRECTION choice (via
            // offer_choices), and must NOT claim any crawl ran. The choice
            // renders as inline clickable options in the chat transcript.
            const body = (await page.locator("body").innerText()).toLowerCase();
            expect(body, "the AI offers the design-direction choice (1:1 / refresh / optimize)").toMatch(/beibehalten|auffrisch|optimiert/);
            expect(body, "the AI must NOT claim it already crawled").not.toMatch(/crawl (abgeschlossen|complete|done|fertig)|habe .* gecrawlt/);
        }
        finally {
            site.stop();
        }
    });
});
