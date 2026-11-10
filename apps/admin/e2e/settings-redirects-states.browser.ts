// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — redirects are draft state, and Settings → Redirects shows it.
 * Pins:
 *   - a new redirect is saved Staged by default ("With the next Publish
 *     live"), or as a Draft ("Later, keep it as a draft");
 *   - the row actions move it: Keep as draft, Include in next publish,
 *     Discard change; the All / Staged / Draft filters and the total follow;
 *   - Go live now is refused with its reason for a change a page caused (it
 *     goes live with that page change), and before anything is live;
 *   - the server-side search finds a rule by its from path (#1540).
 *
 * The spec owns the rules under /e2e1550-; an automatic change (a page
 * rename's 301) is seeded as the page-move gateway leaves it.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx\`DELETE FROM pending_redirects WHERE from_path LIKE '/e2e1550-%'\`;
    await tx\`DELETE FROM redirects WHERE from_path LIKE '/e2e1550-%'\`;
    if (process.env.E2E_OP === "seed") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      await tx\`INSERT INTO pending_redirects (address, from_path, to_path, status_code, state, origin, actor_id)
        VALUES ('/e2e1550-renamed', '/e2e1550-renamed', '/', 301, 'staged', 'page_move', \${actor[0].id})\`;
    }
  });
  await sql.end();
`;

const fixture = (op: "reset" | "seed") => runBunInline(FIXTURE, { E2E_OP: op });

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const row = (page: Page, fromPath: string) =>
  page.locator(`[data-testid="redirect-rule"][data-from="${fromPath}"]`);

async function addRedirect(page: Page, fromPath: string, when: "next_publish" | "later") {
  await page.getByLabel("From", { exact: true }).fill(fromPath);
  await page.getByLabel("To", { exact: true }).fill("/");
  await page.locator(`input[name="goLive"][value="${when}"]`).check();
  await page.getByRole("button", { name: "Add redirect" }).click();
}

test.describe("Redirects are draft state (#1550)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => {
    clearLoginRateBucket();
    fixture("seed");
  });
  test.afterAll(() => fixture("reset"));

  test("a save is Staged by default; the row actions move it", async ({ page }) => {
    await login(page);
    await page.goto("/settings/redirects?q=/e2e1550-");
    await expect(page.locator('input[name="goLive"][value="next_publish"]')).toBeChecked();

    await addRedirect(page, "/e2e1550-campaign", "next_publish");
    await expect(
      page.getByText("staging serves it now, your live site with the next Publish live"),
    ).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-");
    const campaign = row(page, "/e2e1550-campaign");
    await expect(campaign.getByTestId("redirect-state")).toContainText("Staged");

    await campaign.getByRole("button", { name: "Keep as draft" }).click();
    await expect(page.getByText("Kept as a draft")).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-");
    await expect(row(page, "/e2e1550-campaign").getByTestId("redirect-state")).toContainText(
      "Draft",
    );

    // The filters: Draft shows it, Staged does not.
    await page.goto("/settings/redirects?q=/e2e1550-&state=draft");
    await expect(row(page, "/e2e1550-campaign")).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-&state=staged");
    await expect(row(page, "/e2e1550-campaign")).toHaveCount(0);

    await page.goto("/settings/redirects?q=/e2e1550-");
    await row(page, "/e2e1550-campaign")
      .getByRole("button", { name: "Include in next publish" })
      .click();
    await expect(page.getByText("Included: staging serves it now")).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-");
    await expect(row(page, "/e2e1550-campaign").getByTestId("redirect-state")).toContainText(
      "Staged",
    );

    await row(page, "/e2e1550-campaign").getByRole("button", { name: "Discard change" }).click();
    await expect(page.getByText("Change discarded")).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-campaign");
    await expect(row(page, "/e2e1550-campaign")).toHaveCount(0);
  });

  test("Later saves a Draft, served nowhere", async ({ page }) => {
    await login(page);
    await page.goto("/settings/redirects");
    await addRedirect(page, "/e2e1550-later", "later");
    await expect(page.getByText("saved as a draft: served nowhere")).toBeVisible();
    await page.goto("/settings/redirects?q=/e2e1550-later");
    await expect(row(page, "/e2e1550-later").getByTestId("redirect-state")).toContainText("Draft");
    await expect(page.getByTestId("redirect-total")).toContainText("1 rule");
  });

  test("Go live now is refused with its reason for a page's change", async ({ page }) => {
    await login(page);
    await page.goto("/settings/redirects?q=/e2e1550-renamed");
    const renamed = row(page, "/e2e1550-renamed");
    await expect(renamed.getByTestId("redirect-state")).toContainText("Staged");
    await expect(renamed).toContainText("From a page rename or move");
    // An automatic change is never kept as a draft or put live on its own.
    await expect(renamed.getByRole("button", { name: "Keep as draft" })).toHaveCount(0);
    const goLive = renamed.getByTestId("redirect-go-live");
    await expect(goLive).toBeDisabled();
    // Nothing live yet, or the page change it waits for: either reason names Publish live.
    await expect(renamed.getByTestId("redirect-go-live-reason")).toContainText("Publish live");
  });
});
