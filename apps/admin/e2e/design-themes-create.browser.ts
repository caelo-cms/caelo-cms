// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — the Owner create-theme dialog after the preset removal.
 *
 *   1. /design/themes Create dialog renders NO preset picker — the new
 *      variant starts from the active theme's tokens (AI chat is the
 *      path for fully new palettes, per §1A).
 *   2. Description is required (it is the design rationale the
 *      cold-start gate reads).
 *   3. Submitting queues a §11.A proposal that is visible at
 *      /security/themes/pending — nothing is created without the
 *      Owner's Approve click.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const ts = Date.now();
const SLUG = `e2e-themes-create-${ts}`;
const DISPLAY_NAME = `E2E themes create ${ts}`;
const DESCRIPTION = `Indigo variant minted by the design-themes-create e2e flow ${ts}`;

test.afterEach(() => {
  // The flow only queues a proposal (never approves), so cleaning the
  // pending row is enough — no themes row exists for this slug.
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM theme_pending_actions WHERE payload::text LIKE \${'%' + process.env.SLUG + '%'}\`;
    });
    await sql.end();
    `,
    { SLUG },
  );
});

test("create dialog has no preset picker, requires description, queues a proposal", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/design/themes");
  await page.getByRole("button", { name: /create theme/i }).click();
  await expect(page.getByRole("heading", { name: "Create theme" })).toBeVisible();

  // issue #112 — the preset menu is gone for good.
  await expect(page.getByLabel("Preset")).toHaveCount(0);
  await expect(page.getByText(/starts from the active theme/i)).toBeVisible();

  // Description is a required field (design rationale).
  await expect(page.locator("#ct-description")).toHaveAttribute("required", "");

  await page.locator("#ct-slug").fill(SLUG);
  await page.locator("#ct-displayName").fill(DISPLAY_NAME);
  await page.locator("#ct-primaryColor").fill("#4f46e5");
  await page.locator("#ct-description").fill(DESCRIPTION);
  await page.getByRole("button", { name: /queue proposal/i }).click();

  // Form action returns ok + message; the layout-level toast surfaces it.
  await expect(page.getByText(/Proposal queued/i)).toBeVisible({ timeout: 15_000 });

  // §11.A — the proposal waits for the Owner at the pending queue.
  await page.goto("/security/themes/pending");
  await expect(page.getByText(SLUG)).toBeVisible({ timeout: 15_000 });
});
