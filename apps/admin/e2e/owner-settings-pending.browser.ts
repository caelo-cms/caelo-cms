// SPDX-License-Identifier: MPL-2.0

/**
 * /security/owner-settings/pending — the Owner queue for AI-proposed
 * settings changes that wait for a decision (proposals queued over the
 * Power-MCP, where there is no in-chat card).
 *
 *   - a queued gateway proposal renders with its before→after summary;
 *   - Approve runs owner_settings.execute_proposal through the real form
 *     action (routing + CSRF) and the setting changes;
 *   - Reject closes a second proposal without touching the setting.
 *
 * The proposals are seeded straight into the pending table (the shape the
 * propose op writes); the propose op itself is covered by the admin-core
 * integration suite.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
// Distinct, valid debounce values so the two proposals never collide.
const APPROVE_MS = 30_000 + (ts % 1000);
const REJECT_MS = 40_000 + (ts % 1000);

function seedProposal(debounceMs: number): void {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const ms = Number(process.env.MS);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const summary = "autoRedeployDebounceMs: 12000 → " + ms;
      await tx\`
        INSERT INTO owner_settings_pending_actions
          (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES ('set_gateway_settings', \${actor}::uuid,
                \${JSON.stringify({ autoRedeployDebounceMs: ms })}::jsonb,
                \${JSON.stringify({ summary, changes: { autoRedeployDebounceMs: { from: 12000, to: ms } } })}::jsonb,
                'pending', \${"e2e-owner-settings-" + ms})\`;
    });
    await sql.end();
    `,
    { MS: String(debounceMs) },
  );
}

function readDebounce(): number {
  return Number(
    runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let out = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = (await tx\`SELECT auto_redeploy_debounce_ms AS v FROM site_settings WHERE id = 1\`)[0].v;
    });
    await sql.end();
    process.stdout.write(String(out));
  `),
  );
}

let originalDebounce = 0;

test.beforeAll(() => {
  originalDebounce = readDebounce();
  seedProposal(APPROVE_MS);
  seedProposal(REJECT_MS);
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM owner_settings_pending_actions WHERE payload_hash LIKE 'e2e-owner-settings-%'\`;
      await tx\`UPDATE site_settings SET auto_redeploy_debounce_ms = \${Number(process.env.MS)} WHERE id = 1\`;
    });
    await sql.end();
    `,
    { MS: String(originalDebounce) },
  );
});

test("Owner approves one settings proposal and rejects another", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/security/owner-settings/pending");
  const card = (ms: number) =>
    page.getByTestId("owner-settings-proposal").filter({ hasText: `→ ${ms}` });
  await expect(card(APPROVE_MS)).toBeVisible();
  await expect(card(REJECT_MS)).toBeVisible();

  await card(APPROVE_MS).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Setting applied.")).toBeVisible({ timeout: 15_000 });
  await expect(card(APPROVE_MS)).toHaveCount(0);
  expect(readDebounce()).toBe(APPROVE_MS);

  await card(REJECT_MS).getByLabel("Reject reason (optional)").fill("not now");
  await card(REJECT_MS).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Proposal rejected.")).toBeVisible({ timeout: 15_000 });
  await expect(card(REJECT_MS)).toHaveCount(0);
  expect(readDebounce()).toBe(APPROVE_MS);
});
