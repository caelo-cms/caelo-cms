// SPDX-License-Identifier: MPL-2.0

/**
 * Real image generation via Nano Banana (`gemini-2.5-flash-image`) through
 * `@ai-sdk/google`'s multimodal generateText path. Opt-in: needs
 * GOOGLE_GENERATIVE_AI_API_KEY (a billed image provider) — skips without
 * it, like the other expensive livedit scenarios.
 *
 * The seed configures an image-capable `google` provider so generate_image
 * has a target (Anthropic — the chat primary — can't do images). The AI
 * generates a real image and it must land as a persisted media asset.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "./fixtures.js";
import { loginAsDevOwner, resetLiveditFixtures, sendChatPromptAndWait } from "./helpers.js";

/** Run a one-off bun+SQL snippet against the admin DB (system actor scope). */
function runSql(body: string): string {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        ${body}
      });
      await c.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Count persisted AI-generated media assets. */
function aiImageCount(): number {
  const out = runSql(`
    const rows = await tx\`
      SELECT count(*)::int AS n FROM media_assets
      WHERE original_name LIKE 'ai-generated-%' AND deleted_at IS NULL
    \`;
    process.stdout.write(String(rows[0]?.n ?? 0));
  `);
  return Number.parseInt(out || "0", 10);
}

test.describe("e2e-livedit — image generation (Nano Banana)", () => {
  test.skip(
    !process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    "opt-in: needs GOOGLE_GENERATIVE_AI_API_KEY — real Nano Banana image gen (billed)",
  );

  test.beforeEach(() => {
    resetLiveditFixtures();
  });

  test.afterAll(() => {
    runSql("await tx`DELETE FROM media_assets WHERE original_name LIKE 'ai-generated-%'`;");
  });

  test("AI generates a real image and it persists to media_assets", async ({ page }) => {
    const before = aiImageCount();

    await loginAsDevOwner(page);
    await page.goto("/edit");
    await sendChatPromptAndWait(
      page,
      "Generate a brand-new AI image: a minimal, flat-design mountain logo in blue. " +
        "Use the generate_image tool and save it to the media library.",
    );

    // The generate_image tool → GeminiSdkImageProvider → real Nano Banana →
    // sharp pipeline → media.upload. Poll to absorb generation latency (~5s)
    // plus the DB-visibility gap.
    await expect
      .poll(() => aiImageCount(), {
        timeout: 45_000,
        message: "expected a real Nano Banana image to persist to media_assets",
      })
      .toBeGreaterThan(before);
  });
});
