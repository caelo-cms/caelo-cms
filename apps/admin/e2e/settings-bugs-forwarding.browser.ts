// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#905) — the Owner decides whether detected bugs go to the
 * Caelo team. Pins:
 *   - with a bug report on file and no decision yet, the bell asks once and
 *     opens /settings/bugs;
 *   - "What gets sent" shows the exact payload, redacted (no email, no link);
 *   - "Send bugs to Caelo" turns forwarding on: the report is waiting to be
 *     sent and the bell question is gone;
 *   - a report filed before the opt-in is only sent after "Send N earlier
 *     reports";
 *   - "Stop sending" takes back what has not left yet.
 *
 * The suite's admin points CAELO_BUG_INTAKE_URL at a closed port
 * (playwright.config.ts), so nothing leaves the test machine. The tests
 * share the install's one consent row, so they run one after another.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    if (process.env.E2E_OP === "reset") {
      await tx\`DELETE FROM ai_bug_reports WHERE title LIKE 'E2E BF %'\`;
      await tx\`UPDATE telemetry_settings SET bug_forwarding_enabled = false,
        bug_forwarding_decided_at = NULL WHERE id = 1\`;
    }
    if (process.env.E2E_OP === "file") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      await tx\`INSERT INTO ai_bug_reports (actor_id, title, what_happened, expected, suspected_tool, evidence)
        VALUES (\${actor[0].id}, \${process.env.E2E_TITLE},
          'screenshot_page ignored the selector for max@example.de',
          'A cropped screenshot.', 'screenshot_page', 'see https://kunde.example.de/preise')\`;
    }
  });
  await sql.end();
`;

const fixture = (op: "reset" | "file", title = "") =>
  runBunInline(FIXTURE, { E2E_OP: op, E2E_TITLE: title });

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

const row = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(title) });

test.describe("Detected bugs → Caelo team", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => clearLoginRateBucket());
  test.beforeEach(() => fixture("reset"));
  test.afterAll(() => fixture("reset"));

  test("the Owner is asked once, previews the redacted payload and opts in", async ({ page }) => {
    fixture("file", "E2E BF before opt-in");
    await login(page);
    // Login lands in the chrome-less editor; the bell lives in the app shell.
    await page.goto("/settings");

    await page.getByRole("button", { name: /Notifications/ }).click();
    await page.getByTestId("bug-forwarding-notice").click();
    await expect(page).toHaveURL(/\/settings\/bugs$/);

    await row(page, "E2E BF before opt-in").click();
    await page.getByRole("button", { name: "What gets sent" }).click();
    const preview = page.locator("pre", { hasText: '"protocolVersion": 1' });
    await expect(preview).toContainText("[email]");
    await expect(preview).toContainText("[url]");
    await expect(preview).not.toContainText("max@example.de");
    await expect(preview).not.toContainText("kunde.example.de");

    const card = page.getByTestId("bug-forwarding");
    await card.getByRole("button", { name: "Send bugs to Caelo" }).click();
    await expect(card).toContainText("On.");
    // The earlier report was not covered by the opt-in.
    await card.getByRole("button", { name: "Send 1 earlier report" }).click();
    await expect(card).toContainText("1 waiting");
    await expect(row(page, "E2E BF before opt-in")).toContainText("Queued");

    // Decided: the bell no longer asks.
    await page.getByRole("button", { name: /Notifications/ }).click();
    await expect(page.getByTestId("bug-forwarding-notice")).toHaveCount(0);
  });

  test("stop sending takes back what has not left yet", async ({ page }) => {
    await login(page);
    await page.goto("/settings/bugs");
    const card = page.getByTestId("bug-forwarding");
    await card.getByRole("button", { name: "Send bugs to Caelo" }).click();
    await expect(card).toContainText("On.");
    fixture("file", "E2E BF queued");
    await page.goto("/settings/bugs");
    await card.getByRole("button", { name: "Send 1 earlier report" }).click();
    await expect(row(page, "E2E BF queued")).toContainText("Queued");

    await card.getByRole("button", { name: "Stop sending" }).click();
    await expect(card).toContainText("Reports stay on this site");
    await expect(row(page, "E2E BF queued")).toContainText("This site only");
  });
});
