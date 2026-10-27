// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — saved redirects go live on the hosting without a build, and a push
 * that failed is never silent. Pins:
 *   - Settings → Redirects shows, per target, whether the saved redirects are
 *     live; a failed push shows its error, the automatic retry and that
 *     target's "Try again now";
 *   - the notification bell names it and links to Settings → Redirects.
 *
 * The failure is seeded as the sync leaves it (target behind, last error,
 * a failed attempt in the history): the suite's stack has no hosting to fail
 * against on demand. The spec owns only the production target's sync state
 * (it resets it before and after) and asserts only production's row: specs
 * running in parallel seed staging runs with no build on disk, so staging's
 * row may show a real failure at any time.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const prod = await tx\`SELECT id FROM deploy_targets WHERE env = 'production' ORDER BY name LIMIT 1\`;
    await tx\`DELETE FROM redirect_syncs WHERE target_id = \${prod[0].id}\`;
    await tx\`INSERT INTO redirect_sync_state (target_id) VALUES (\${prod[0].id})
      ON CONFLICT (target_id) DO UPDATE SET wanted_revision = redirect_sync_state.synced_revision,
        failed_attempts = 0, next_attempt_at = NULL, last_error = NULL\`;
    if (process.env.E2E_OP === "fail") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      await tx\`UPDATE redirect_sync_state SET wanted_revision = synced_revision + 1,
        failed_attempts = 1, next_attempt_at = now() + interval '1 hour',
        last_error = 'E2E: the URL-map update failed' WHERE target_id = \${prod[0].id}\`;
      await tx\`INSERT INTO redirect_syncs (target_id, trigger, status, revision, error_message, actor_id)
        VALUES (\${prod[0].id}, 'save', 'failed', 1, 'E2E: the URL-map update failed', \${actor[0].id})\`;
    }
  });
  await sql.end();
`;

const fixture = (op: "reset" | "fail") => runBunInline(FIXTURE, { E2E_OP: op });

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.describe("Redirects live on the hosting (#1157)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => clearLoginRateBucket());
  test.afterAll(() => fixture("reset"));

  test("a failed push shows in Settings → Redirects and in the bell", async ({ page }) => {
    fixture("fail");
    await login(page);
    await page.goto("/settings/redirects");
    const card = page.getByTestId("redirect-sync-status");
    const production = card.locator('[data-testid="redirect-sync-target"][data-env="production"]');
    await expect(production).toContainText("Not live — push failed");
    await expect(production).toContainText("E2E: the URL-map update failed");
    await expect(production).toContainText("Retried automatically");
    await expect(production.getByRole("button", { name: "Try again now" })).toBeVisible();

    // The count is part of the bell's name once it is hydrated and polled.
    await page.getByRole("button", { name: /^Notifications, \S+ pending$/ }).click();
    const notice = page.getByTestId("redirect-sync-notice");
    await expect(notice).toContainText("Saved redirects are not live yet");
    await expect(notice).toHaveAttribute("href", "/settings/redirects");
  });

  test("Try again now retries that target and clears the failure", async ({ page }) => {
    fixture("fail");
    await login(page);
    await page.goto("/settings/redirects");
    const production = page
      .getByTestId("redirect-sync-status")
      .locator('[data-testid="redirect-sync-target"][data-env="production"]');
    await production.getByRole("button", { name: "Try again now" }).click();
    // Production in the suite's stack has no build that cannot be served,
    // so the retry succeeds ("Live" or "Nothing published yet").
    await expect(page.getByText("Redirects are live on your hosting.").first()).toBeVisible();
    await expect(production).not.toContainText("push failed");
    await expect(production.getByRole("button", { name: "Try again now" })).toHaveCount(0);
  });

  test("in sync, no failure and no retry button", async ({ page }) => {
    fixture("reset");
    await login(page);
    await page.goto("/settings/redirects");
    // Only production's state is this spec's: other specs seed staging runs
    // without a build on disk, so staging may genuinely be failing meanwhile.
    const production = page
      .getByTestId("redirect-sync-status")
      .locator('[data-testid="redirect-sync-target"][data-env="production"]');
    await expect(production).toBeVisible();
    await expect(production).not.toContainText("push failed");
    await expect(production.getByRole("button", { name: "Try again now" })).toHaveCount(0);
  });
});
