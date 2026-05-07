// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.44 — End-to-end propose → approve flow exercised through the UI.
 *
 * Asserts that the unified `/security/pending` inbox + per-domain
 * `/security/users/pending` queue work together: a queued AI proposal
 * shows up in the inbox, links to the per-domain page, the operator
 * approves, and the underlying entity (a new users row) lands.
 *
 * Setup: a pending users.propose_create row is seeded directly into
 * `user_pending_actions` via a Bun subprocess (the AI's would-be
 * call). The browser flow then logs in as the dev-owner and walks
 * through the approve UI.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const TEST_EMAIL = "e2e-propose-test@example.com";

test.beforeAll(() => {
  clearLoginRateBucket();
  // Wipe any lingering test row from prior runs so the test is reentrant.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM user_pending_actions WHERE payload->>'email' = \${process.env.E2E_EMAIL}\`;
      await tx\`DELETE FROM users WHERE email = \${process.env.E2E_EMAIL}\`;
    });
    await sql.end();
  `,
    { E2E_EMAIL: TEST_EMAIL },
  );
});

test("propose → /security/pending inbox → /security/users/pending → approve → user lands", async ({
  page,
}) => {
  // 1. Seed a pending proposal directly. Simulates the AI calling
  //    users.propose_create. Uses the dev-owner's actor as proposed_by
  //    so the row passes RLS.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const owners = await tx\`SELECT id FROM users WHERE is_first_owner = true LIMIT 1\`;
      const ownerId = owners[0].id;
      await tx\`
        INSERT INTO user_pending_actions
          (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES (
          'create',
          \${ownerId}::uuid,
          \${JSON.stringify({
            email: process.env.E2E_EMAIL,
            displayName: "E2E Test User",
            roleNames: [],
          })}::jsonb,
          \${JSON.stringify({
            email: process.env.E2E_EMAIL,
            displayName: "E2E Test User",
            roleNames: [],
            passwordPolicy: "server-generated-on-approve",
          })}::jsonb,
          'pending',
          \${"e2e-test-hash-" + Date.now()}
        )
      \`;
    });
    await sql.end();
  `,
    { E2E_EMAIL: TEST_EMAIL },
  );

  // 2. Login as Owner.
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // 3. Navigate to the unified inbox. The proposal we just seeded
  //    should be visible with the AI-supplied summary + a Review link.
  await page.goto("/security/pending");
  await expect(page.getByText(`${TEST_EMAIL}`)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/users\.create/)).toBeVisible();
  // Per-domain count badge.
  await expect(page.getByText(/users:\s*1/)).toBeVisible();

  // 4. Click Review → should navigate to /security/users/pending.
  await page
    .getByRole("link", { name: /Review/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/security\/users\/pending/, { timeout: 5_000 });
  await expect(page.getByText(`${TEST_EMAIL}`)).toBeVisible();

  // 5. Approve the proposal.
  await page.getByRole("button", { name: /^Approve$/ }).click();
  await expect(page.getByText(/Proposal applied/i)).toBeVisible({ timeout: 10_000 });
  // Server-generated temp password renders in the banner.
  await expect(page.getByText(/One-time password/i)).toBeVisible();

  // 6. Verify the underlying users row exists.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    let count = 0;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = await tx\`SELECT 1 FROM users WHERE email = \${process.env.E2E_EMAIL} AND deleted_at IS NULL\`;
      count = rows.length;
    });
    await sql.end();
    if (count !== 1) throw new Error("expected 1 users row after approve, got " + count);
  `,
    { E2E_EMAIL: TEST_EMAIL },
  );

  // 7. Cleanup so re-runs are clean.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM user_pending_actions WHERE payload->>'email' = \${process.env.E2E_EMAIL}\`;
      await tx\`DELETE FROM users WHERE email = \${process.env.E2E_EMAIL}\`;
    });
    await sql.end();
  `,
    { E2E_EMAIL: TEST_EMAIL },
  );
});
