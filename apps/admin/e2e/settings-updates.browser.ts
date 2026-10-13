// SPDX-License-Identifier: MPL-2.0

/**
 * #696 — Settings → Caelo updates. Pins:
 *   - an Owner sees the newest release and the exact, version-pinned upgrade
 *     command for this install, and the copy button puts it on the clipboard;
 *   - a role without settings.write (Reviewer) sees the versions but no
 *     command — it is told to ask an Owner;
 *   - the bell's release notice opens /settings/updates;
 *   - Phase 2 "Install update": the Owner sets up Google sign-in, confirms
 *     with a fresh sign-in (step-up), confirms the install, and follows the
 *     upgrader's live timeline — fed here the way the job writes it; a
 *     release that changes the cloud setup shows the Cloud Shell step.
 *
 * The suite's admin runs with test-only stand-ins (playwright.config.ts,
 * ignored when NODE_ENV=production): CAELO_E2E_FAKE_UPGRADER (starting the
 * job starts nothing) and CAELO_E2E_FAKE_GOOGLE_SIGNIN (the sign-in comes
 * straight back with an ID token for the signed-in user; the challenge,
 * nonce, freshness and email checks all run for real).
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
    } else if (op === "reset-install") {
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`DELETE FROM step_up_google_client\`;
    } else if (op === "job-progress") {
      // What the upgrader job writes while it runs (platform-updater ops).
      const [r] = await tx\`SELECT id FROM platform_update_requests ORDER BY requested_at DESC LIMIT 1\`;
      await tx\`UPDATE platform_update_requests SET status = 'running', started_at = now() WHERE id = \${r.id}\`;
      for (const [phase, level, message] of [
        ["verify", "success", "Release information verified: signed by Caelo's release workflow."],
        ["backup", "success", "Backup 1760000000000 taken."],
        ["migrations", "info", "Applying DB migrations (idempotent)..."],
      ]) {
        await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                 VALUES (\${r.id}, \${phase}, \${level}, \${message})\`;
      }
    } else if (op === "job-finish") {
      const [r] = await tx\`SELECT id FROM platform_update_requests ORDER BY requested_at DESC LIMIT 1\`;
      await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
               VALUES (\${r.id}, 'finish', 'success', 'Caelo installed.')\`;
      await tx\`UPDATE platform_update_requests SET status = 'succeeded', finished_at = now() WHERE id = \${r.id}\`;
    } else if (op === "needs-shell") {
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, status, status_reason,
                  refusal_codes, started_at, finished_at)
               VALUES (\${process.env.E2E_LATEST}, '0.10.45', 'manual', \${owner.id}, 'needs_cloud_shell',
                 'v99.0.0 changes this install''s cloud setup (infrastructure contract 1 → 2).',
                 ARRAY['infra-contract'], now(), now())\`;
    } else if (op === "wipe") {
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`DELETE FROM step_up_google_client\`;
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
  // The Owner installs from the admin; the command is the alternative.
  await page.getByText("Install from a terminal instead").click();
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
  await page.getByText("Install from a terminal instead").click();
  await expect(page.getByTestId("upgrade-command")).toHaveText(COMMAND);
});

test("Install update: Google sign-in setup, step-up, confirm, live timeline", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/updates");

  // One-time setup: the install's own Google OAuth client.
  await expect(page.getByTestId("step-up-setup")).toBeVisible();
  await expect(page.getByTestId("step-up-redirect-uri")).toContainText(
    "/settings/updates/step-up/callback",
  );
  await page.getByLabel("Client ID").fill("123456789-e2eclient.apps.googleusercontent.com");
  await page.getByLabel("Client secret").fill("e2e-client-secret-value");
  await page.getByTestId("save-step-up-client").click();

  // No step-up yet: the only way on is a fresh Google sign-in.
  await expect(page.getByTestId("open-install-dialog")).toHaveCount(0);
  await page.getByTestId("step-up-install").click();

  // Back from (stand-in) Google: confirmed, and the confirmation opens.
  await expect(page.getByTestId("step-up-fresh")).toBeVisible();
  const dialog = page.getByTestId("install-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("backed up");
  await dialog.getByTestId("confirm-install").click();

  // The request is queued and the (stand-in) upgrader started.
  const timeline = page.getByTestId("update-timeline");
  await expect(timeline).toContainText(`→ v${LATEST}`);
  await expect(page.getByTestId("update-status")).toHaveText("Waiting to start");
  await expect(timeline).toContainText("Upgrader started (run e2e-upgrader-");
  // The step-up was used up: cancelling needs a new sign-in.
  await expect(page.getByTestId("cancel-update")).toHaveText("Cancel (confirm with Google first)");

  // The job reports progress; the page follows without a reload.
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "job-progress", E2E_EMAIL: REVIEWER_EMAIL });
  await expect(page.getByTestId("update-status")).toHaveText("Installing", { timeout: 15_000 });
  await expect(timeline.locator('[data-phase="migrations"]')).toContainText(
    "Updating the database",
  );
  await expect(timeline.locator('[data-phase="backup"]')).toContainText("Backup 1760000000000");

  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "job-finish", E2E_EMAIL: REVIEWER_EMAIL });
  await expect(page.getByTestId("update-status")).toHaveText("Installed", { timeout: 15_000 });

  // History survives a reload (it is in the database, like the timeline).
  await page.reload();
  await expect(page.getByTestId("update-history")).toContainText(`→ v${LATEST}`);
  await expect(page.getByTestId("update-history")).toContainText("Installed");
});

test("a release that changes the cloud setup explains the Cloud Shell step", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "needs-shell",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await login(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/updates");
  const card = page.getByTestId("cloud-shell-upgrade");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("cloud-shell-reason")).toContainText("infrastructure contract");
  await expect(page.getByTestId("open-cloud-shell")).toHaveAttribute(
    "href",
    /^https:\/\/(shell|console)\.cloud\.google\.com\//,
  );
  await expect(page.getByTestId("cloud-shell-command").last()).toHaveText(COMMAND);
});
