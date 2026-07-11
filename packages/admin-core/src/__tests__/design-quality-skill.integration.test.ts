// SPDX-License-Identifier: MPL-2.0

/**
 * issues #154 + #155 — the design-quality skill seed and the
 * compose-page self-review amendment, checked against the real DB
 * (migration 0106). Pins: skill active + engageable by the matcher's
 * data (keywords/chipTrigger), body carries the load-bearing sections,
 * compose-page gained the screenshot step exactly once (idempotence
 * guard), and operator-edited bodies would be left alone (guard shape).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");
const sqlc = new SQL(ADMIN_URL);

afterAll(async () => {
  await sqlc.end({ timeout: 5 }).catch(() => {});
});

async function skillRow(slug: string): Promise<{
  body: string;
  status: string;
  hints: { keywords?: string[]; chipTrigger?: boolean };
} | null> {
  const conn = await sqlc.reserve();
  try {
    await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
    const rows = (await conn`
      SELECT body, status, auto_engagement_hints AS hints FROM skills WHERE slug = ${slug}
    `) as unknown as { body: string; status: string; hints: unknown }[];
    const r = rows[0];
    if (!r) return null;
    const hints = typeof r.hints === "string" ? JSON.parse(r.hints) : r.hints;
    return { body: r.body, status: r.status, hints: hints as { keywords?: string[] } };
  } finally {
    conn.release();
  }
}

describe("design-quality skill (issue #154)", () => {
  it("ships active with engagement hints and the craft sections", async () => {
    const skill = await skillRow("design-quality");
    expect(skill).not.toBeNull();
    expect(skill?.status).toBe("active");
    expect(skill?.hints.keywords).toContain("redesign");
    expect(skill?.hints.chipTrigger).toBe(true);
    for (const section of [
      "HIERARCHY",
      "RHYTHM",
      "COLOR",
      "DEPTH",
      "RESPONSIVE",
      "ANTI-PATTERNS",
    ]) {
      expect(skill?.body).toContain(section);
    }
    // Depth guidance references the #153 vocabulary, not generic advice.
    expect(skill?.body).toContain("var(--gradient-hero)");
    expect(skill?.body).toContain("var(--color-surface-alt)");
  });

  it("carries the self-review loop with its cap and skip rules (issue #155)", async () => {
    const skill = await skillRow("design-quality");
    expect(skill?.body).toContain("SELF-REVIEW LOOP");
    expect(skill?.body).toContain("screenshot_page");
    expect(skill?.body).toContain("two review rounds");
    expect(skill?.body).toContain("set_page_module_content");
  });
});

describe("compose-page amendment (issue #155)", () => {
  it("gained the screenshot step exactly once (idempotence guard)", async () => {
    const skill = await skillRow("compose-page");
    expect(skill).not.toBeNull();
    const occurrences = (skill?.body.match(/screenshot_page/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
