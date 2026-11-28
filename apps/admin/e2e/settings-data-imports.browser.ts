// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports (docs/data-imports.md) — Settings → Data imports. Pins: an
 * operator uploads a file and gets the id to give the AI, with its row
 * count; a file Caelo cannot read is refused with the reason; an import is
 * listed with where it stands and Undo asks first, then marks it undone.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx\`DELETE FROM data_imports WHERE source_label LIKE 'E2E %'\`;
    await tx\`DELETE FROM data_uploads WHERE filename LIKE 'e2e-%'\`;
    if (process.env.E2E_OP === "seed") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      await tx\`INSERT INTO data_imports (owner, kind, release, source_label, created_by)
        VALUES ('core', 'redirects', 'target', 'E2E Yoast export', \${actor[0].id})\`;
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

test.describe("Data imports", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => clearLoginRateBucket());
  test.beforeEach(() => fixture("reset"));
  test.afterAll(() => fixture("reset"));

  test("an upload gives the id for the AI; an unreadable file is refused with the reason", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings/data-imports");
    await page.locator("#data-import-file").setInputFiles({
      name: "e2e-comments.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("sourceKey,authorName\nwp:1,Anna\nwp:2,Ben\n"),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("alert").getByText(/2 rows/)).toBeVisible();
    await expect(page.getByRole("alert").getByText(/import upload [0-9a-f-]{36}/)).toBeVisible();

    await page.locator("#data-import-file").setInputFiles({
      name: "e2e-broken.csv",
      mimeType: "text/csv",
      buffer: Buffer.from('a,b\n"never closed,1\n'),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByRole("alert").getByText(/never closed/)).toBeVisible();
  });

  test("an import is listed with its state, and Undo asks first", async ({ page }) => {
    await fixture("seed");
    await login(page);
    await page.goto("/settings/data-imports");
    const row = page.getByRole("row", { name: /E2E Yoast export/ });
    await expect(row.getByText("Saved as pending changes")).toBeVisible();
    await row.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Undo import" }).click();
    await expect(
      page.getByRole("row", { name: /E2E Yoast export/ }).getByText("Undone"),
    ).toBeVisible();
  });
});
