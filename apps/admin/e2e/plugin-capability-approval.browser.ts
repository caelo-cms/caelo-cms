// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — a shipped plugin whose release asks for a capability the
 * Owner has not approved for it waits for that approval (one plugin model):
 * Settings → Updates names it, Settings → Plugins shows what it asks for and
 * the Approve button, and one click approves it.
 *
 * The upgrade is simulated the way migration 0431 leaves an install: the
 * plugin's approved set is what the previous release asked for, without the
 * new `change_journal`.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);
test.describe.configure({ mode: "serial" });

const SLUG = "international-site";

function setApproved(capabilities: string[] | null): void {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const caps = JSON.parse(process.env.CAPS);
      if (caps === null) {
        await tx\`UPDATE plugins SET approved_capabilities = ARRAY(
          SELECT jsonb_array_elements_text(manifest_json -> 'requestedCapabilities'))
          WHERE slug = \${process.env.SLUG}\`;
      } else {
        await tx\`UPDATE plugins SET approved_capabilities = ARRAY(
          SELECT jsonb_array_elements_text((\${JSON.stringify(caps)}::text)::jsonb))
          WHERE slug = \${process.env.SLUG}\`;
      }
    });
    await sql.end();
  `,
    { SLUG, CAPS: JSON.stringify(capabilities) },
  );
}

test("a new permission waits for the Owner, is named on Updates, and one click approves it", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/settings/plugins");
  const activate = page.getByTestId(`activate-${SLUG}`);
  if ((await activate.count()) > 0) {
    await activate.click();
    await expect(page.getByTestId(`activate-${SLUG}`)).toHaveCount(0, { timeout: 30_000 });
  }

  // What the previous release ran with: everything but change_journal.
  setApproved([
    "cms_admin",
    "cms_admin_schema",
    "ai_provider",
    "chat_runner_tools",
    "background_workers",
    "head_contributions",
    "content_variants",
    "link_resolve",
    "list_sources",
    "list_resolve",
  ]);
  try {
    await page.goto("/settings/updates");
    const notice = page.getByTestId("plugins-awaiting-approval");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(SLUG);
    await expect(notice).toContainText("change_journal");

    await page.goto("/settings/plugins");
    await expect(page.getByTestId(`unapproved-${SLUG}`)).toContainText("change_journal");
    await page.getByTestId(`approve-capabilities-${SLUG}`).click();
    await expect(page.getByTestId(`approve-capabilities-${SLUG}`)).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.goto("/settings/updates");
    await expect(page.getByTestId("plugins-awaiting-approval")).toHaveCount(0);
  } finally {
    setApproved(null);
  }
});
