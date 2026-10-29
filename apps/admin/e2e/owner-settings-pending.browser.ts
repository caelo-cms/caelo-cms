// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/owner-settings/pending — the Owner queue for AI-proposed
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
// Distinct, valid body caps so the two proposals never collide.
const APPROVE_BYTES = 30_000 + (ts % 1000);
const REJECT_BYTES = 40_000 + (ts % 1000);

function seedProposal(maxBodyBytes: number): void {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const bytes = Number(process.env.BYTES);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const summary = "maxBodyBytes: 65536 → " + bytes;
      await tx\`
        INSERT INTO owner_settings_pending_actions
          (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES ('set_gateway_settings', \${actor}::uuid,
                (\${JSON.stringify({ maxBodyBytes: bytes })}::text)::jsonb,
                (\${JSON.stringify({ summary, changes: { maxBodyBytes: { from: 65536, to: bytes } } })}::text)::jsonb,
                'pending', \${"e2e-owner-settings-" + bytes})\`;
    });
    await sql.end();
    `,
    { BYTES: String(maxBodyBytes) },
  );
}

function readBodyCap(): number {
  return Number(
    runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let out = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = (await tx\`SELECT gateway_max_body_bytes AS v FROM site_settings WHERE id = 1\`)[0].v;
    });
    await sql.end();
    process.stdout.write(String(out));
  `),
  );
}

let originalBodyCap = 0;

test.beforeAll(() => {
  originalBodyCap = readBodyCap();
  seedProposal(APPROVE_BYTES);
  seedProposal(REJECT_BYTES);
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM owner_settings_pending_actions WHERE payload_hash LIKE 'e2e-owner-settings-%'\`;
      await tx\`UPDATE site_settings SET gateway_max_body_bytes = \${Number(process.env.BYTES)} WHERE id = 1\`;
    });
    await sql.end();
    `,
    { BYTES: String(originalBodyCap) },
  );
});

test("Owner approves one settings proposal and rejects another", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/settings/owner-settings/pending");
  const card = (bytes: number) =>
    page.getByTestId("owner-settings-proposal").filter({ hasText: `→ ${bytes}` });
  await expect(card(APPROVE_BYTES)).toBeVisible();
  await expect(card(REJECT_BYTES)).toBeVisible();

  await card(APPROVE_BYTES).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Setting applied.")).toBeVisible({ timeout: 15_000 });
  await expect(card(APPROVE_BYTES)).toHaveCount(0);
  expect(readBodyCap()).toBe(APPROVE_BYTES);

  await card(REJECT_BYTES).getByLabel("Reject reason (optional)").fill("not now");
  await card(REJECT_BYTES).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Proposal rejected.")).toBeVisible({ timeout: 15_000 });
  await expect(card(REJECT_BYTES)).toHaveCount(0);
  expect(readBodyCap()).toBe(APPROVE_BYTES);
});
