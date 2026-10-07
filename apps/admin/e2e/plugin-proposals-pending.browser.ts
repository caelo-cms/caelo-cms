// SPDX-License-Identifier: MPL-2.0

/**
 * /security/plugins/pending — the Owner queue for plugin proposals that wait
 * for a decision (activate / uninstall / revoke_capability queued over the
 * Power-MCP, where there is no in-chat card).
 *
 *   - a queued revoke proposal renders with its effect line;
 *   - Approve on a proposal whose installation is gone surfaces the
 *     executor's error instead of pretending success;
 *   - Reject closes it.
 *
 * The apply path itself (grant revoked, plugin disabled, plugins.install
 * required) is covered by plugin-owner-tools.integration.test.ts.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const SLUG = `e2e-plugin-queue-${Date.now()}`;

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const slug = process.env.SLUG;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`)[0].id;
      await tx\`
        INSERT INTO plugin_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES ('revoke_capability', \${actor}::uuid,
                \${JSON.stringify({ slug, installationId: crypto.randomUUID(), capability: "private_files" })}::jsonb,
                \${JSON.stringify({ slug, capability: "private_files", effect: "e2e revoke effect " + slug })}::jsonb,
                'pending', \${"e2e-" + slug})\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM plugin_pending_actions WHERE payload_hash = \${"e2e-" + process.env.SLUG}\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

test("Owner sees a queued plugin proposal, a failed apply is reported, reject closes it", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/security/plugins/pending");
  const card = page.getByTestId("plugin-proposal").filter({ hasText: `e2e revoke effect ${SLUG}` });
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Approve" }).click();
  // The page alert (a toast repeats it, hence the role scope).
  await expect(page.getByRole("alert").getByText(/revoke_capability failed/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toBeVisible();

  await card.getByLabel("Reject reason (optional)").fill("not now");
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("alert").getByText("Proposal rejected.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toHaveCount(0);
});
