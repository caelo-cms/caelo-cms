// SPDX-License-Identifier: MPL-2.0

/**
 * Image generation end to end. A fixture provider streams a single
 * `generate_image` tool call; the FakeImageProvider (enabled via
 * CAELO_FAKE_IMAGE_PROVIDER=1 in playwright.config.ts) returns a 1×1 PNG
 * data-URL instead of hitting a real image API — so the whole
 * generate_image → download → media pipeline → media_assets row path runs
 * in the DEFAULT per-PR suite, for free and deterministically.
 *
 * Covers: the AI can request an image and it lands as a persisted media
 * asset (the resulting `<img src>` the AI references is therefore backed
 * by a real row, not a dead ephemeral URL).
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  registerTestProvider,
  runBunInline,
} from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
});

const ts = Date.now();
const PROVIDER = `image-gen-${ts}`;
const BASE = "http://localhost:4173";

/** Count persisted AI-generated media assets. */
function aiImageCount(): number {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { SQL } from "bun";
      const c = new SQL(process.env.ADMIN_DATABASE_URL);
      await c.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = await tx\`
          SELECT count(*)::int AS n FROM media_assets
          WHERE original_name LIKE 'ai-generated-%' AND deleted_at IS NULL
        \`;
        process.stdout.write(String(rows[0]?.n ?? 0));
      });
      await c.end();
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return Number.parseInt(r.stdout.trim() || "0", 10);
}

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
  // Remove the assets this run generated so reruns stay clean.
  runBunInline(
    `
    import { SQL } from "bun";
    const c = new SQL(process.env.ADMIN_DATABASE_URL);
    await c.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM media_assets WHERE original_name LIKE 'ai-generated-%'\`;
    });
    await c.end();
    `,
  );
});

test("AI generate_image persists a media asset via the fake image provider", async ({
  context,
  page,
}) => {
  const before = aiImageCount();

  await registerTestProvider(BASE, PROVIDER, [
    [
      {
        kind: "tool-call",
        id: `tu_img_${ts}`,
        name: "generate_image",
        arguments: {
          prompt: "a serene mountain landscape at golden hour for the homepage hero",
          altText: `AI generated hero ${ts}`,
        },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "I generated the hero image and saved it to your media library." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/edit");
  await page.locator("textarea").fill("generate a hero image for the homepage");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(
    page.getByText("saved it to your media library").first(),
  ).toBeVisible({ timeout: 30_000 });

  // The generate_image tool ran during turn 1: a new media asset must have
  // landed (fake PNG → download → sharp pipeline → media.upload). Poll to
  // absorb the tiny gap between the turn-2 text streaming and the media
  // row being visible to a fresh DB connection.
  await expect
    .poll(() => aiImageCount(), {
      timeout: 10_000,
      message: "expected generate_image to persist one new media asset",
    })
    .toBeGreaterThan(before);
});
