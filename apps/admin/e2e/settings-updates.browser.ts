// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 0 — Settings → Caelo updates. Pins:
 *   - an Owner sees the newest release and the exact, version-pinned upgrade
 *     command for this install, and the copy button puts it on the clipboard;
 *   - a role without settings.write (Reviewer) sees the versions but no
 *     command — it is told to ask an Owner;
 *   - the bell's release notice opens /settings/updates.
 *
 * The release check is switched off for the suite (CAELO_RELEASE_CHECK=off in
 * playwright.config.ts) and its cache seeded here, so GitHub never decides
 * what the test sees. The suite's admin runs with CAELO_SITE_URL
 * http://localhost:8082 and the Google Cloud provider stand-in, so the
 * install is named `localhost`.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const LATEST = "99.0.0";
const COMMAND = `bunx @caelo-cms/provisioning@${LATEST} upgrade --version ${LATEST} --install localhost`;
const ts = Date.now();
const REVIEWER_EMAIL = `e2e-updates-reviewer-${ts}@example.com`;
const REVIEWER_PASSWORD = "reviewer dev password";

const FIXTURE_SCRIPT = `
  import { SQL } from "bun";
  const op = process.env.E2E_OP;
  const email = process.env.E2E_EMAIL;
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    if (op === "seed") {
      await tx\`
        UPDATE release_check_cache
           SET latest_version = \${process.env.E2E_LATEST},
               release_url = 'https://github.com/caelo-cms/caelo-cms/releases',
               release_notes = '## Highlights\n\nA release seeded by the e2e suite.',
               published_at = now(),
               fetched_at = now()
         WHERE id = 1\`;
      const { hashPassword } = await import("@caelo-cms/admin-core");
      const pwd = await hashPassword(process.env.E2E_PASSWORD);
      const actor = await tx\`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'E2E Updates Reviewer')
        RETURNING id::text AS id\`;
      const actorId = actor[0]?.id;
      if (!actorId) throw new Error("seed actor returned no row");
      await tx\`
        INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
        VALUES (\${actorId}::uuid, \${email}, \${pwd}, false, now())\`;
      await tx\`
        INSERT INTO user_roles (user_id, role_id)
        SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'reviewer'\`;
    } else if (op === "wipe") {
      await tx\`
        UPDATE release_check_cache
           SET latest_version = NULL, release_url = NULL, release_notes = NULL,
               published_at = NULL, fetched_at = '1970-01-01T00:00:00Z'
         WHERE id = 1\`;
      await tx\`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM users WHERE email = \${email}\`;
    } else {
      throw new Error("unknown E2E_OP: " + op);
    }
  });
  await sql.end();
`;

// One seeded cache row and one Reviewer for the whole file: run its tests in
// one worker so beforeAll/afterAll happen once (fullyParallel would repeat
// them per worker).
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  clearLoginRateBucket();
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "seed",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_PASSWORD: REVIEWER_PASSWORD,
    E2E_LATEST: LATEST,
  });
});
test.afterAll(() => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "wipe", E2E_EMAIL: REVIEWER_EMAIL });
});

async function login(page: Page, email: string, password: string): Promise<void> {
  // Every spec logs in from a fresh context; a long run fills the per-IP bucket.
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test("an Owner sees the pinned upgrade command and copies it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/updates");
  await expect(page.getByRole("heading", { level: 1, name: "Caelo updates" })).toBeVisible();
  await expect(page.getByTestId("latest-version")).toHaveText(`v${LATEST}`);
  await expect(page.getByTestId("release-notes")).toContainText("seeded by the e2e suite");
  await expect(page.getByTestId("upgrade-command")).toHaveText(COMMAND);

  await page.getByTestId("copy-upgrade-command").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
});

test("a Reviewer sees the versions but no command", async ({ page }) => {
  await login(page, REVIEWER_EMAIL, REVIEWER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(page.getByTestId("latest-version")).toHaveText(`v${LATEST}`);
  await expect(page.getByTestId("upgrade-ask-owner")).toBeVisible();
  await expect(page.getByTestId("upgrade-command")).toHaveCount(0);
  await expect(page.getByTestId("copy-upgrade-command")).toHaveCount(0);
});

test("the bell's release notice opens Settings → Caelo updates", async ({ page }) => {
  await login(page, "dev-owner@example.com", "dev owner password");
  // The bell lives in the AppShell topbar (not on the full-screen /edit).
  await page.goto("/settings");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const notice = page.getByTestId("release-notice");
  await expect(notice).toHaveAttribute("href", "/settings/updates");
  await notice.click();
  await expect(page).toHaveURL("/settings/updates");
  await expect(page.getByTestId("upgrade-command")).toHaveText(COMMAND);
});
