// SPDX-License-Identifier: MPL-2.0

/**
 * Chips appended via the "+ Reference module" dropdown ride through one
 * AI turn. Verifies:
 *   - Picking a module from the dropdown adds a removable chip.
 *   - Sending the message clears the chips and ships them to the server.
 *   - Server-side, the chips are inlined into the user message body
 *     (see chat-runner.ts: chips are formatted into the persisted user
 *     content so the AI sees them as structured context).
 *
 * Uses the fixture-replay provider so the AI's reply is deterministic.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const FIXTURE_PATH = "/tmp/caelo-ai-fixture.json";
const ts = Date.now();
const SLUGS = [`e2e-chip-a-${ts}`, `e2e-chip-b-${ts}`, `e2e-chip-c-${ts}`];

test.afterEach(() => {
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM modules WHERE slug LIKE 'e2e-chip-%'\`;
    });
    await sql.end();
    `,
  );
});

test("chips appended via dropdown ride one AI turn", async ({ page }) => {
  // Seed three modules.
  for (const slug of SLUGS) {
    runBunInline(
      `
      import { SQL } from "bun";
      const sql = new SQL(process.env.ADMIN_DATABASE_URL);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx\`
          INSERT INTO modules (slug, display_name, html)
          VALUES (\${process.env.SLUG}, \${process.env.SLUG}, '<p>x</p>')
          ON CONFLICT (slug) DO NOTHING
        \`;
      });
      await sql.end();
      `,
      { SLUG: slug },
    );
  }

  // Single-shot fixture: AI just acknowledges with text, no tool call.
  // The point is the chips → user message round-trip.
  writeFileSync(
    FIXTURE_PATH,
    JSON.stringify([
      { kind: "text-delta", text: "Got it — three references." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ]),
  );

  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Add three chips by picking from the dropdown three times.
  const dropdown = page.getByLabel("+ Reference module");
  for (const slug of SLUGS) {
    const opt = page.locator(`select option`).filter({ hasText: slug }).first();
    const value = (await opt.getAttribute("value")) ?? "";
    expect(value).not.toBe("");
    await dropdown.selectOption(value);
  }

  // Three chip pills present — chip spans are removable (have a × button
  // inside), the dropdown options aren't.
  const chipPills = page.locator("span", { hasText: "×" });
  await expect(chipPills).toHaveCount(3);
  for (const slug of SLUGS) {
    await expect(page.locator("span", { hasText: slug }).filter({ hasText: "×" })).toHaveCount(1);
  }

  // Send.
  await page.locator("textarea").fill("make them all green");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(page.getByText(/three references/i)).toBeVisible({ timeout: 15_000 });

  // After send, the chips are cleared from the composer.
  await expect(page.locator("span", { hasText: "×" })).toHaveCount(0);

  // Reload to pull the persisted user message — chat-runner inlines the
  // chip references into the stored content so the AI sees them as
  // structured context.
  await page.reload();
  await expect(page.getByText(/Element references attached/i)).toBeVisible();
  for (const slug of SLUGS) {
    await expect(
      page
        .locator("li")
        .filter({ hasText: /Element references attached/ })
        .getByText(slug),
    ).toBeVisible();
  }
});
