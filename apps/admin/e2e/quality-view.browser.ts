// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — /security/quality, the Owner's quality view. An accepted
 * finding is listed with its reason, and the Owner revokes it through the
 * real form action (routing + CSRF + quality_acceptances.revoke), after
 * which the row shows as revoked. The acceptance is seeded straight into
 * the table (the shape the in-chat accept card writes); the ops themselves
 * are covered by the admin-core integration suite.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const REASON = `e2e-quality-view-${Date.now()}`;

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      const page = (await tx\`SELECT id FROM pages ORDER BY created_at LIMIT 1\`)[0];
      if (!page) throw new Error("quality-view e2e: no page in the seeded site");
      await tx\`
        INSERT INTO quality_acceptances (page_id, kind, audit_id, reason, accepted_by)
        VALUES (\${page.id}::uuid, 'finding', 'image-alt', \${process.env.REASON}, \${actor}::uuid)\`;
    });
    await sql.end();
    `,
    { REASON },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM quality_acceptances WHERE reason = \${process.env.REASON}\`;
    });
    await sql.end();
    `,
    { REASON },
  );
});

test("Owner sees the quality gate and revokes an accepted finding", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/security/quality");
  await expect(page.getByTestId("quality-gate-card")).toBeVisible();
  const row = page.getByTestId("quality-acceptance-row").filter({ hasText: REASON });
  await expect(row).toBeVisible();
  await expect(row).toContainText("image-alt");

  await row.getByLabel("Reason for revoking this acceptance (optional)").fill("fix it properly");
  await row.getByTestId("quality-revoke-btn").click();
  await expect(row.getByText("revoked")).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId("quality-revoke-btn")).toHaveCount(0);
});
