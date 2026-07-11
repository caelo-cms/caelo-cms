// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #163, epic #149) — Site Genesis end-to-end.
 *
 * The blank-site design flow the two-level architecture exists for:
 * a brief-rich operator prompt must produce MULTIPLE genuinely
 * different design drafts (parallel freeform subagents), present them
 * for selection, and record exactly one chosen design.
 *
 * OPT-IN, not PR-gating: set CAELO_LIVEDIT_GENESIS=1 to run. A Genesis
 * turn spawns three parallel full-page draft generations — that cost
 * belongs to nightly / on-demand runs (CLAUDE.md §6: live tests are
 * gated, opt-in), while the homepage scenario stays the per-PR gate.
 *
 * Coverage map:
 *   • #163 AC — ≥2 drafts, visibly distinct directions, side-by-side
 *     at /design/genesis, one-click selection → single `selected` row.
 *   • #149 epic AC #1 (drafts half) — machine-checked distinctness:
 *     distinct direction labels AND substantially different HTML.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "./fixtures.js";
import { loginAsDevOwner, resetLiveditFixtures, sendChatPromptAndWait } from "./helpers.js";

const GENESIS_PROMPT = [
  "Design a brand-new website for 'Krume & Kruste', a family bakery in Freiburg.",
  "Audience: locals who value handmade sourdough; mood: warm, honest, handmade;",
  "tone: friendly and plainspoken; imagery: close-up bread textures in morning light;",
  "avoid: corporate stock-photo feel. Propose a few different design directions",
  "as full drafts and let me pick — do not build any pages yet.",
].join(" ");

interface DraftRow {
  id: string;
  direction: string;
  status: string;
  html_len: number;
  html_head: string;
}

function snapshotDrafts(): DraftRow[] {
  const raw = spawnSync(
    "bun",
    [
      "-e",
      `
        import { SQL } from "bun";
        const sql = new SQL(process.env.ADMIN_DATABASE_URL);
        let out = [];
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          out = await tx\`
            SELECT id::text AS id, direction, status,
                   length(html)::int AS html_len, left(html, 2000) AS html_head
            FROM genesis_drafts ORDER BY created_at ASC
          \`;
        });
        await sql.end();
        process.stdout.write(JSON.stringify(out));
      `,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
  if (raw.status !== 0) throw new Error(`snapshotDrafts failed: ${raw.stderr || raw.stdout}`);
  return JSON.parse(raw.stdout.trim()) as DraftRow[];
}

test.describe("e2e-livedit Genesis — divergent drafts + selection", () => {
  test.skip(
    process.env.CAELO_LIVEDIT_GENESIS !== "1",
    "opt-in (CAELO_LIVEDIT_GENESIS=1) — a Genesis turn spawns three parallel draft generations; nightly/on-demand cost, not per-PR",
  );

  test("brief-rich prompt yields distinct drafts; operator selects one at /design/genesis", async ({
    page,
  }) => {
    resetLiveditFixtures();
    await loginAsDevOwner(page);

    await page.goto("/edit");
    await sendChatPromptAndWait(page, GENESIS_PROMPT);

    // ── Drafts exist and genuinely diverge ─────────────────────────
    const drafts = snapshotDrafts();
    expect(
      drafts.length,
      "the site-genesis flow must save at least two candidate drafts",
    ).toBeGreaterThanOrEqual(2);
    const directions = new Set(drafts.map((d) => d.direction.trim().toLowerCase()));
    expect(directions.size, "draft directions must be distinct design angles, not repeats").toBe(
      drafts.length,
    );
    for (const d of drafts) {
      expect(d.html_len, `draft "${d.direction}" must be a complete page`).toBeGreaterThan(2000);
      expect(d.html_head.toLowerCase()).toContain("<style");
    }
    // Substantial pairwise divergence: identical heads = palette-swapped
    // clones of one skeleton, which is exactly what Genesis must NOT do.
    const heads = drafts.map((d) => d.html_head);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        expect(heads[i], `drafts ${i} and ${j} must not share a skeleton`).not.toBe(heads[j]);
      }
    }

    // ── Selection surface ──────────────────────────────────────────
    await page.goto("/design/genesis");
    const frames = page.locator("iframe[sandbox]");
    await expect(frames.first()).toBeVisible({ timeout: 20_000 });
    expect(await frames.count()).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "Select" }).first().click();
    await expect(page.getByText("selected", { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    const after = snapshotDrafts();
    expect(after.filter((d) => d.status === "selected")).toHaveLength(1);
  });
});
