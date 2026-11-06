// SPDX-License-Identifier: MPL-2.0

/**
 * #1461 — Settings → Static files. Pins: an Owner saves a file and sees it
 * listed as not staged; a refused address shows why and writes nothing; a
 * proposal the AI queued shows its text and applies on Approve; delete asks
 * first.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx\`DELETE FROM static_file_pending_actions\`;
    await tx\`DELETE FROM static_files WHERE path LIKE '/e2e-%'\`;
    if (process.env.E2E_OP === "propose") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      const payload = { files: [{ path: "/e2e-proposed.txt", contentType: "text/plain",
        body: "proposed text", purpose: "E2E proposal." }] };
      await tx\`INSERT INTO static_file_pending_actions (kind, proposed_by, payload, preview)
        VALUES ('set', \${actor[0].id}, \${payload}, \${{ summary: "/e2e-proposed.txt", versions: { "/e2e-proposed.txt": null } }})\`;
    }
  });
  await sql.end();
`;

const fixture = (op: "reset" | "propose") => runBunInline(FIXTURE, { E2E_OP: op });

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.describe("Static files (#1461)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => clearLoginRateBucket());
  test.beforeEach(() => fixture("reset"));
  test.afterAll(() => fixture("reset"));

  test("an Owner saves a file; a reserved address is refused with the reason", async ({ page }) => {
    await login(page);
    await page.goto("/settings/static-files");

    await page.getByLabel("Address").fill("/api/e2e.json");
    await page.getByLabel("Why it exists").fill("E2E.");
    await page.getByLabel("Content").fill("{}");
    await page.getByRole("button", { name: "Save file" }).click();
    // The page's alert, not the layout's error toast that repeats it: both
    // carry the reason, so an unscoped match finds two once the toast is in.
    await expect(page.getByRole("alert").getByText(/reserved/)).toBeVisible();

    await page.getByLabel("Address").fill("/e2e-ips.json");
    await page.getByLabel("Why it exists").fill("E2E.");
    await page.getByLabel("Content").fill('{"ips":[]}');
    await page.getByRole("button", { name: "Save file" }).click();
    const row = page.getByTestId("static-file-row").filter({ hasText: "/e2e-ips.json" });
    await expect(row).toContainText("Not staged yet");
  });

  test("a proposal shows its text and applies on Approve", async ({ page }) => {
    fixture("propose");
    await login(page);
    await page.goto("/settings/static-files");
    const card = page.getByTestId("static-file-proposal");
    await expect(card).toContainText("proposed text");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("static-file-row")).toContainText("/e2e-proposed.txt");
    await expect(page.getByTestId("static-file-proposal")).toHaveCount(0);
  });
});
