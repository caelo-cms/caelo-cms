// SPDX-License-Identifier: MPL-2.0

/**
 * #1454 — Settings → Security headers. Pins: the page opens with report-only
 * and says what enforcing rests on; a keyword as an origin is refused with
 * the reason and writes nothing; a save persists and says it needs a Stage;
 * a proposal the AI queued shows up in the owner-settings queue and applies
 * on Approve.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const DEFAULT_POLICY = {
  cspMode: "report_only",
  frameAncestors: [],
  referrerPolicy: "strict-origin-when-cross-origin",
  allowedFeatures: [],
  hsts: { maxAgeSeconds: 31536000, includeSubdomains: false, preload: false },
  extraSources: {},
};

const FIXTURE = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  const policy = ${JSON.stringify(JSON.stringify(DEFAULT_POLICY))};
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx\`DELETE FROM owner_settings_pending_actions WHERE kind = 'set_security_headers'\`;
    await tx\`UPDATE site_settings SET security_headers = \${policy}::text::jsonb WHERE id = 1\`;
    if (process.env.E2E_OP === "propose") {
      const actor = await tx\`SELECT id FROM actors WHERE kind = 'system' LIMIT 1\`;
      const payload = { frameAncestors: ["https://partner.example.com"] };
      const preview = {
        summary: "security headers: frameAncestors",
        changes: { frameAncestors: { from: [], to: payload.frameAncestors } },
      };
      await tx\`INSERT INTO owner_settings_pending_actions (kind, proposed_by, payload, preview)
        VALUES ('set_security_headers', \${actor[0].id}, \${payload}, \${preview})\`;
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

test.describe("Security headers (#1454)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => clearLoginRateBucket());
  test.beforeEach(() => fixture("reset"));
  test.afterAll(() => fixture("reset"));

  test("opens on report-only and says what enforcing rests on", async ({ page }) => {
    await login(page);
    await page.goto("/settings/security-headers");
    await expect(page.getByRole("heading", { name: "Security headers" })).toBeVisible();
    await expect(page.getByLabel("Mode")).toHaveValue("report_only");
    await expect(page.getByTestId("security-headers-evidence")).toContainText(
      "reaches nobody and is blocked for visitors",
    );
    await expect(page.getByLabel("Seconds browsers remember it")).toHaveValue("31536000");
  });

  test("refuses a keyword as an origin, with the reason, and saves a real one", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings/security-headers");

    await page.getByLabel("Also allow: Scripts").fill("'unsafe-inline'");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText(/an origin like https:\/\/cdn\.example\.com/).first(),
    ).toBeVisible();

    await page.goto("/settings/security-headers");
    await expect(page.getByLabel("Also allow: Scripts")).toHaveValue("");
    await page.getByLabel("Also allow: Requests from scripts").fill("https://api.vendor.com");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Saved\. Staging sends the new headers/).first()).toBeVisible();

    await page.goto("/settings/security-headers");
    await expect(page.getByLabel("Also allow: Requests from scripts")).toHaveValue(
      "https://api.vendor.com",
    );
    await expect(page.getByText(/newer than the staged build/)).toBeVisible();
  });

  test("a queued proposal applies on Approve", async ({ page }) => {
    fixture("propose");
    await login(page);
    await page.goto("/settings/owner-settings/pending");
    const card = page
      .getByTestId("owner-settings-proposal")
      .filter({ hasText: "Security headers" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card).toBeHidden();

    await page.goto("/settings/security-headers");
    await expect(page.getByLabel("Sites that may embed this site in a frame")).toHaveValue(
      "https://partner.example.com",
    );
  });
});
