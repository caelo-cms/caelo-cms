// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #835 — the Live edit toolbar without pending edits but with a
 * staged build offered Stage again only while the quality gate reported
 * problems. A Publish live refused by the parity guard (#834) then left the
 * operator with no way to re-Stage from Live edit.
 *
 * Asserted: a fresh chat (no pending edits) with a staged build shows ONE
 * Stage again control next to Publish live, whatever the gate says, and it
 * submits the Stage action. The parity refusal itself needs a publisher
 * with a separate staging host (gcp-firebase); the admin-core integration
 * suite (staging-domain) covers it, including the upgrade wording.
 *
 * The staged build is seeded straight into deploy_runs (the shape a
 * succeeded Stage writes); the build itself does not run here.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  resetOverlayLayoutFor,
  runBunInline,
} from "./helpers.js";

// Its own Owner, so its chat is never another spec's Live edit chat.
const OWNER_EMAIL = "stage-again-e2e-owner@example.com";
let seededRunId = "";

test.beforeAll(() => {
  clearLoginRateBucket();
  const ownerId = ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
  seededRunId = runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const target = (await tx\`SELECT id FROM deploy_targets WHERE name = 'staging'\`)[0];
      if (!target) throw new Error("stage-again e2e: no staging deploy target");
      // Dated now, not ahead: any newer Stage another spec makes is just as
      // good a "staged build" for this toolbar shape.
      const run = (await tx\`INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (\${target.id}, \${process.env.OWNER_ID}::uuid, 'succeeded', now(), now(), 'e2e-stage-again')
        RETURNING id::text AS id\`)[0];
      return run.id;
    });
    await sql.end();
    process.stdout.write(id);
    `,
    { OWNER_ID: ownerId },
  ).trim();
});

test.afterAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM deploy_runs WHERE id = \${process.env.RUN_ID}::uuid\`;
    });
    await sql.end();
    `,
    { RUN_ID: seededRunId },
  );
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("no pending edits + a staged build: one Stage again in the Staging menu", async ({ page }) => {
  await login(page);
  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const chatId = page.url().split("/").pop() ?? "";

  await page.goto(`/edit?chat=${chatId}`);
  const publish = page.getByTestId("promote-only-btn");
  await expect(publish).toBeVisible({ timeout: 15_000 });

  // Stage again lives in the Staging menu, next to Publish live.
  await page.getByTestId("staging-menu").click();
  const restage = page.getByTestId("restage-btn");
  await expect(restage).toHaveCount(1);
  await expect(restage).toBeVisible();
  await expect(restage).toBeEnabled();
  await expect(restage).toHaveText("Stage again");
  // The retired problems-only copy is gone: one control.
  await expect(page.getByTestId("quality-restage-btn")).toHaveCount(0);
  // It rebuilds staging from main through the Stage action.
  const action = await restage.evaluate(
    (el) => (el as HTMLButtonElement).form?.getAttribute("action") ?? "",
  );
  expect(action).toBe("?/stageAndDeployStaging");
});
