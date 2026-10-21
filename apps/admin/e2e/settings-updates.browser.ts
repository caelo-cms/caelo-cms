// SPDX-License-Identifier: MPL-2.0

/**
 * #696, #861 — Settings → Caelo updates. The page shows ONE state in a
 * status card on top (data-state = updatePageState's kind) with one
 * sentence and exactly one primary action; one flow below per state:
 * no_permission, in_progress, interrupted, rolled_back, break_glass (a
 * refused run, and a release predicted to change the cloud setup, #817),
 * update_available, scheduled, up_to_date, unknown — plus a stale Cloud
 * Shell request that stays in the history, a run that died without
 * reporting back (`interrupted`, its log), and a day-old check that no
 * longer claims "Up to date" (`unknown`). Also pins:
 *   - an Owner sees the newest release and the exact, version-pinned upgrade
 *     command for this install, and the copy button puts it on the clipboard;
 *   - a role without settings.write (Reviewer) sees the versions but no
 *     command — it is told to ask an Owner;
 *   - the bell's release notice opens /settings/updates;
 *   - Phase 2 "Install update": the Owner confirms the install with their
 *     password (step-up, #757) — a wrong one is refused in the dialog, five
 *     sign the session out — and follows the upgrader's live timeline — fed here the way the job writes it; a
 *     release that changes the cloud setup shows the Cloud Shell step;
 *   - Phase 4c, self-hosted (the `caelo_e2e_updates_provider` cookie
 *     switches this browser to a self-hosted install): without a running
 *     update agent the Owner gets its setup command and the server-side
 *     upgrade command; with one checking in, "Install update" queues the
 *     request for it; a release it cannot install shows the server step.
 *   - the release check: when it last ran ("checked 40 min ago"), a failed
 *     check never reads as "Up to date", and "Check now" (open to a Reviewer,
 *     who holds settings.read) refreshes it — at most once a minute;
 *   - Phase 5 "Automatic updates": every policy change, pause and resume
 *     asks for the password again; the page shows the scheduler's
 *     last decision and the update emails (and that none were sent while
 *     no email service is set up); a Reviewer only reads.
 *   - #862: the release notes read in Owner words (no hashes, issue numbers
 *     or "BREAKING"); the policy form is one choice (Notify only / Install
 *     automatically) whose kinds show only under "Install automatically"
 *     and stay stored when "Notify only" is saved; window, waits and pause
 *     sit under "More settings".
 *
 * The suite's admin runs with test-only stand-ins (playwright.config.ts,
 * ignored when NODE_ENV=production): CAELO_E2E_FAKE_UPGRADER (starting the
 * job starts nothing). The password confirmation runs for real.
 *
 * The release check is switched off for the suite (CAELO_RELEASE_CHECK=off in
 * playwright.config.ts) and its cache seeded here, so GitHub never decides
 * what the test sees; "Check now" asks a stand-in that names v99.0.0
 * (CAELO_E2E_FAKE_RELEASE_CHECK, lib/server/release-check.ts). The suite's admin runs with CAELO_SITE_URL
 * http://localhost:8082 and the Google Cloud provider stand-in, so the
 * install is named `localhost`.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, runBunInline } from "./helpers.js";

const LATEST = "99.0.0";
const COMMAND = `bunx @caelo-cms/provisioning@${LATEST} upgrade --version ${LATEST} --install localhost`;
/** #816 — the one line the Cloud Shell upgrade walkthrough runs. */
const SHELL_COMMAND = "./run.sh upgrade --install localhost";
const ts = Date.now();
const REVIEWER_EMAIL = `e2e-updates-reviewer-${ts}@example.com`;
const REVIEWER_PASSWORD = "reviewer dev password";
const OWNER_PASSWORD = "dev owner password";

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
               release_notes = '### Features\n- 1a2b3c4d feat(editor): a release seeded by the e2e suite (#12) (#13) ⚠ BREAKING\n\n### Docs\n- 5e6f7a8b a docs-only change (#14)\n',
               published_at = now(),
               latest_infra_change = NULL, infra_change_from = NULL,
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
      await tx\`UPDATE release_check_cache SET latest_version = \${process.env.E2E_LATEST || "99.0.0"},
                 latest_infra_change = NULL, infra_change_from = NULL, fetched_at = now() WHERE id = 1\`;
      await tx\`UPDATE platform_update_scheduler SET last_action = NULL, last_version = NULL,
                 last_wait_until = NULL, last_reason = NULL\`;
    } else if (op === "ended-run") {
      // A finished run for the newest release, as the upgrader job leaves it:
      // E2E_STATUS, the phases it reached (E2E_PHASES, comma-separated).
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      const [r] = await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, status, status_reason,
                  started_at, finished_at)
               VALUES (\${process.env.E2E_LATEST}, '0.10.52', 'manual', \${owner.id},
                 \${process.env.E2E_STATUS}, \${process.env.E2E_REASON || null}, now(), now())
               RETURNING id\`;
      for (const phase of (process.env.E2E_PHASES ?? "").split(",").filter(Boolean)) {
        await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                 VALUES (\${r.id}, \${phase}, 'info', \${"Reached " + phase + "."})\`;
      }
    } else if (op === "dead-run") {
      // A request the job claimed (running, its execution recorded) whose
      // run then died without writing its end: the fake upgrader reports
      // that execution as over (the caelo_e2e_upgrader_run cookie).
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      const [r] = await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, status, execution, started_at)
               VALUES (\${process.env.E2E_LATEST}, '0.10.52', 'manual', \${owner.id}, 'running',
                 'e2e-upgrader-ended', now())
               RETURNING id\`;
      for (const phase of ["queued", "start", "verify", "backup"]) {
        await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                 VALUES (\${r.id}, \${phase}, 'info', \${"Reached " + phase + "."})\`;
      }
    } else if (op === "converge-predicted") {
      // What the release check notes when the newest release's manifest
      // raises the infrastructure contract over the running release (#817).
      const { CAELO_VERSION } = await import("@caelo-cms/shared");
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`UPDATE release_check_cache SET latest_infra_change = true,
                 infra_change_from = \${CAELO_VERSION} WHERE id = 1\`;
    } else if (op === "stale-shell") {
      // A Cloud Shell request for a release older than what runs, and one
      // the admin already closed (#817): history only.
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, requested_at, status,
                  status_reason, started_at, finished_at)
               VALUES ('0.0.2', '0.0.1', 'manual', \${owner.id}, now() - interval '2 days',
                 'superseded', 'No longer needed: this install runs a newer release now.', now(), now()),
                      ('0.0.3', '0.0.2', 'manual', \${owner.id}, now() - interval '1 day',
                 'needs_cloud_shell', 'The release that serves now is not the one install.json names.',
                 now(), now())\`;
    } else if (op === "latest-is-installed") {
      const { CAELO_VERSION } = await import("@caelo-cms/shared");
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`UPDATE release_check_cache SET latest_version = \${CAELO_VERSION}, fetched_at = now()
                WHERE id = 1\`;
    } else if (op === "stale-up-to-date") {
      // The last check that ran found nothing newer — two days ago (the
      // hourly check has not run since).
      const { CAELO_VERSION } = await import("@caelo-cms/shared");
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`UPDATE release_check_cache SET latest_version = \${CAELO_VERSION},
                 fetched_at = now() - interval '2 days' WHERE id = 1\`;
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
                 ARRAY['infra-contract'], now(), now()) RETURNING id\`
        .then(async ([r]) => {
          await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                   VALUES (\${r.id}, 'verify', 'success', 'Release information verified.'),
                          (\${r.id}, 'finish', 'warn', 'Stopped: needs one step by hand.')\`;
        });
    } else if (op === "converge-stalled") {
      // #819 review: a converge whose stage 1 handed over and whose stage-2
      // run never started — running, route converge, NO execution.
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      const [r] = await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, status, route, started_at)
               VALUES (\${process.env.E2E_LATEST}, '0.10.45', 'manual', \${owner.id}, 'running',
                 'converge', now())
               RETURNING id\`;
      for (const [phase, level, message] of [
        ["verify", "success", "Release information verified: signed by Caelo's release workflow."],
        ["backup", "success", "Backup 1760000000000 taken."],
        ["converge", "info", "Handing over to the new release's installer."],
      ]) {
        await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                 VALUES (\${r.id}, \${phase}, \${level}, \${message})\`;
      }
    } else if (op === "auto-reset") {
      await tx\`DELETE FROM platform_update_notifications\`;
      await tx\`UPDATE platform_update_scheduler SET lease_holder = NULL, last_run_at = NULL,
                 last_version = NULL, last_action = NULL, last_reason = NULL, last_wait_until = NULL\`;
      await tx\`UPDATE platform_update_policy SET mode = 'notify', auto_security = false,
                 auto_patch = false, auto_minor = false, auto_converge = false, window_start = NULL, window_end = NULL,
                 window_timezone = 'UTC', soak_hours = 24, security_soak_hours = 2, paused = false,
                 paused_reason = NULL, paused_at = NULL, paused_until = NULL, paused_by = NULL\`;
    } else if (op === "auto-on") {
      // The Owner chose "Install automatically" for bug fixes, an hour ago
      // (before the scheduler's tick that auto-status writes).
      await tx\`UPDATE platform_update_policy SET mode = 'auto', auto_patch = true,
                 updated_at = now() - interval '1 hour'\`;
    } else if (op === "auto-pause") {
      // Paused after the scheduler decided (the decision stays until its next tick).
      await tx\`UPDATE platform_update_policy SET paused = true, paused_at = now(),
                 paused_reason = 'e2e', updated_at = now()\`;
    } else if (op === "auto-status") {
      // What the scheduler writes after a tick (platform_updates.scheduler_tick).
      await tx\`UPDATE platform_update_scheduler SET last_run_at = now(), last_version = \${process.env.E2E_LATEST},
                 last_action = 'wait', last_wait_until = now() + interval '20 hours',
                 last_reason = 'v99.0.0 (patch release) installs automatically once it has been out for 48 hours.'\`;
      await tx\`INSERT INTO platform_update_notifications
                 (kind, target_version, dedupe_key, subject, body, delivery_status, delivery_detail)
               VALUES ('scheduled', \${process.env.E2E_LATEST}, 'scheduled:e2e',
                 'Caelo v99.0.0 will install automatically', 'Body.', 'no_transport',
                 'No email transport is configured (Settings → Email).')\`;
    } else if (op === "agent-beat") {
      // What the update agent writes on every poll (platform-updater ops).
      await tx\`DELETE FROM platform_update_agent\`;
      if (process.env.E2E_AGENT_MINUTES) {
        await tx\`INSERT INTO platform_update_agent (id, agent_version, host, last_seen_at, problem)
                 VALUES (1, '0.10.47', 'e2e-box',
                         now() - make_interval(mins => \${Number(process.env.E2E_AGENT_MINUTES)}),
                         \${process.env.E2E_AGENT_PROBLEM || null})\`;
      }
    } else if (op === "needs-server") {
      await tx\`DELETE FROM platform_update_requests\`;
      const [owner] = await tx\`SELECT id FROM users WHERE email = 'dev-owner@example.com'\`;
      await tx\`INSERT INTO platform_update_requests
                 (target_version, from_version, trigger, requested_by, status, status_reason,
                  refusal_codes, started_at, finished_at)
               VALUES (\${process.env.E2E_LATEST}, '0.10.45', 'manual', \${owner.id}, 'needs_cloud_shell',
                 'This install has not recorded which Caelo release it runs yet. Upgrade it once with the upgrade command on the server.',
                 ARRAY['install-version-unknown'], now(), now()) RETURNING id\`
        .then(async ([r]) => {
          await tx\`INSERT INTO platform_update_events (request_id, phase, level, message)
                   VALUES (\${r.id}, 'verify', 'success', 'Release information verified.'),
                          (\${r.id}, 'finish', 'warn', 'Stopped: needs one step by hand.')\`;
        });
    } else if (op === "checked-ago") {
      // What the hourly release check leaves behind, E2E_MINUTES ago; no
      // E2E_LATEST = that check failed (it reached no release).
      await tx\`
        UPDATE release_check_cache
           SET latest_version = \${process.env.E2E_LATEST || null},
               fetched_at = now() - make_interval(mins => \${Number(process.env.E2E_MINUTES)})
         WHERE id = 1\`;
    } else if (op === "wipe") {
      await tx\`DELETE FROM platform_update_notifications\`;
      await tx\`UPDATE platform_update_policy SET mode = 'notify', auto_security = false,
                 auto_patch = false, auto_minor = false, auto_converge = false, window_start = NULL, window_end = NULL,
                 window_timezone = 'UTC', soak_hours = 24, security_soak_hours = 2, paused = false,
                 paused_reason = NULL, paused_at = NULL, paused_until = NULL, paused_by = NULL\`;
      await tx\`DELETE FROM platform_update_requests\`;
      await tx\`DELETE FROM platform_update_agent\`;
      await tx\`
        UPDATE release_check_cache
           SET latest_version = NULL, release_url = NULL, release_notes = NULL,
               published_at = NULL, latest_infra_change = NULL, infra_change_from = NULL,
               fetched_at = '1970-01-01T00:00:00Z'
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

/** The page's status card (#861) and the state it shows. */
const card = (page: Page) => page.getByTestId("update-status-card");

/** Open one of the collapsed sections by its title. */
async function openSection(page: Page, testid: string): Promise<void> {
  const section = page.getByTestId(testid);
  if ((await section.getAttribute("open")) === null)
    await section.locator(":scope > summary").click();
}

/** Exactly one primary action on the page: none of the others render in the card. */
async function expectOnlyAction(
  page: Page,
  action:
    | "open-install-dialog"
    | "open-cloud-shell"
    | "upgrade-command"
    | "continue-update"
    | "none",
): Promise<void> {
  for (const id of [
    "open-install-dialog",
    "open-cloud-shell",
    "upgrade-command",
    "continue-update",
  ] as const) {
    await expect(card(page).getByTestId(id)).toHaveCount(id === action ? 1 : 0);
  }
}

test("update_available: one Install button on top; the command is under Other ways", async ({
  page,
  context,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(page.getByRole("heading", { level: 1, name: "Caelo updates" })).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-state", "update_available");
  await expect(card(page).getByTestId("target-version")).toHaveText(`v${LATEST}`);
  await expect(page.getByTestId("update-state-sentence")).toHaveText(`v${LATEST} is available.`);
  await expect(page.getByTestId("open-install-dialog")).toHaveText(`Install v${LATEST}…`);
  await expectOnlyAction(page, "open-install-dialog");
  await expect(page.getByTestId("latest-version")).toHaveText(`v${LATEST}`);
  // In Owner words (#862): no hashes, issue numbers, scopes or "BREAKING";
  // docs-only changes left out; the breaking change becomes what to do.
  const releaseNotes = page.getByTestId("release-notes");
  await expect(releaseNotes).toContainText("A release seeded by the e2e suite");
  await expect(releaseNotes).toContainText("Before you update: Nothing to do");
  await expect(releaseNotes).not.toContainText("#12");
  await expect(releaseNotes).not.toContainText("1a2b3c4d");
  await expect(releaseNotes).not.toContainText("BREAKING");
  await expect(releaseNotes).not.toContainText("docs-only");
  await expect(page.getByRole("link", { name: "All changes on GitHub →" })).toBeVisible();
  // Evidence for the PR: the status card on top.
  await card(page).screenshot({ path: test.info().outputPath("status-card-update-available.png") });

  // The terminal and Cloud Shell are reference, collapsed.
  await openSection(page, "section-other-ways");
  await expect(page.getByTestId("upgrade-command")).toHaveText(COMMAND);
  await expect(
    page.getByTestId("section-other-ways").getByTestId("open-cloud-shell"),
  ).toBeVisible();
  await page.getByTestId("copy-upgrade-command").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
});

test("no_permission: a Reviewer is told an Owner installs, with no action", async ({ page }) => {
  await login(page, REVIEWER_EMAIL, REVIEWER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "no_permission");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    "An Owner of this site installs Caelo updates",
  );
  await expectOnlyAction(page, "none");
  await expect(page.getByTestId("section-other-ways")).toHaveCount(0);
  await expect(page.getByTestId("latest-version")).toHaveText(`v${LATEST}`);
});

test("the bell's release notice opens Settings → Caelo updates", async ({ page }) => {
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  // The bell lives in the AppShell topbar (not on the full-screen /edit).
  await page.goto("/settings");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const notice = page.getByTestId("release-notice");
  await expect(notice).toHaveAttribute("href", "/settings/updates");
  await notice.click();
  await expect(page).toHaveURL("/settings/updates");
  await expect(card(page)).toBeVisible();
});

test("in_progress: confirm with the password; the timeline replaces the card body", async ({
  page,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");

  // Nothing to set up first: the button opens the confirmation.
  await page.getByTestId("open-install-dialog").click();
  let dialog = page.getByTestId("install-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("backed up");

  // A wrong password is refused; the dialog comes back with the reason.
  await dialog.getByTestId("install-dialog-password").fill("not the password");
  await dialog.getByTestId("install-dialog-submit").click();
  dialog = page.getByTestId("install-dialog");
  await expect(dialog.getByTestId("install-dialog-error")).toContainText("Wrong password. 4 more");
  await expect(page.getByTestId("update-timeline")).toHaveCount(0);

  await dialog.getByTestId("install-dialog-password").fill(OWNER_PASSWORD);
  await dialog.getByTestId("install-dialog-submit").click();

  // The request is queued and the (stand-in) upgrader started: the card is the timeline.
  await expect(card(page)).toHaveAttribute("data-state", "in_progress");
  const timeline = card(page).getByTestId("update-timeline");
  await expect(timeline).toContainText(`→ v${LATEST}`);
  await expect(page.getByTestId("update-status")).toHaveText("Waiting to start");
  await expect(page.getByTestId("update-progress")).toContainText("as soon as the upgrader starts");
  await expect(timeline).toContainText("Upgrader started (run e2e-upgrader-");
  await expectOnlyAction(page, "none");
  // Cancelling asks for the password again (the confirmation was used up).
  await page.getByTestId("cancel-update").click();
  await expect(page.getByTestId("cancel-dialog-password")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();

  // The job reports progress; the page follows without a reload.
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "job-progress", E2E_EMAIL: REVIEWER_EMAIL });
  await expect(page.getByTestId("update-status")).toHaveText("Installing", { timeout: 15_000 });
  await expect(page.getByTestId("update-progress")).toHaveText(
    `Caelo is installing v${LATEST}. Step 3 of 5: updating the database. You can leave this page.`,
  );
  await expect(timeline.locator('[data-phase="migrations"]')).toContainText(
    "Updating the database",
  );
  await expect(timeline.locator('[data-phase="backup"]')).toContainText("Backup 1760000000000");
  await expect(page.getByTestId("cancel-update")).toHaveCount(0);

  // A newer release shows up meanwhile: the heading still names the
  // release this run installs, like its timeline does.
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "checked-ago",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: "99.1.0",
    E2E_MINUTES: "1",
  });
  await page.reload();
  await expect(card(page)).toHaveAttribute("data-state", "in_progress");
  await expect(card(page).getByTestId("target-version")).toHaveText(`v${LATEST}`);

  // The job ends; the page reloads its state (this stand-in install keeps
  // its version, so the release is still on offer) and keeps the run in
  // the history, which survives a reload (it is in the database).
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "job-finish", E2E_EMAIL: REVIEWER_EMAIL });
  await expect(card(page)).not.toHaveAttribute("data-state", "in_progress", { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId("history-line")).toContainText("installed · 1 entry");
  await openSection(page, "section-history");
  await expect(page.getByTestId("update-history")).toContainText(`→ v${LATEST}`);
  await expect(page.getByTestId("update-history")).toContainText("Installed");
  await expect(page.getByTestId("section-history").locator('[data-phase="finish"]')).toContainText(
    "Installed",
  );
});

test("five wrong passwords for an update action sign the session out", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt === 1) await page.getByTestId("open-install-dialog").click();
    const dialog = page.getByTestId("install-dialog");
    await dialog.getByTestId("install-dialog-password").fill(`wrong ${attempt}`);
    await dialog.getByTestId("install-dialog-submit").click();
    if (attempt < 5) {
      await expect(dialog.getByTestId("install-dialog-error")).toContainText(`${5 - attempt} more`);
    }
  }
  // Signed out (the session row itself is deleted — integration-tested).
  await expect(page).toHaveURL(/\/login/);
});

test("interrupted: a run refused before any change says so and never reads 'Finished'", async ({
  page,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "ended-run",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
    E2E_STATUS: "refused",
    E2E_REASON: "The release information could not be verified.",
    E2E_PHASES: "queued,start,verify,finish",
  });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "interrupted");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    `The update to v${LATEST} stopped before it changed anything.`,
  );
  await expect(page.getByTestId("update-state-detail")).toHaveText(
    "The release information could not be verified.",
  );
  await expect(page.getByTestId("open-install-dialog")).toHaveText("Try again…");
  await expectOnlyAction(page, "open-install-dialog");
  await page.getByTestId("last-attempt").locator("summary").click();
  const finish = page.getByTestId("last-attempt").locator('[data-phase="finish"]');
  await expect(finish).toContainText("Stopped before changing anything");
  await expect(page.getByTestId("last-attempt")).not.toContainText("Finished");
});

test("interrupted: a run that died without reporting back points at its log, not at Install", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "dead-run",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await page
    .context()
    .addCookies([
      { name: "caelo_e2e_upgrader_run", value: "ended", url: baseURL ?? "http://localhost:4173" },
    ]);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "interrupted");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    `The update to v${LATEST} stopped without reporting back.`,
  );
  await expect(page.getByTestId("update-state-detail")).toContainText("within 90 minutes");
  const log = card(page).getByTestId("upgrader-log");
  await expect(log).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/run/jobs/e2e-upgrader-ended",
  );
  // Not "Installing" with a live timeline, and no second action next to the log.
  await expectOnlyAction(page, "none");
  await expect(card(page).getByTestId("cancel-update")).toHaveCount(0);
  await expect(card(page).getByTestId("update-state-badge")).toHaveText("Interrupted");
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

test("rolled_back: the release failed its test; the site is unchanged, Try again", async ({
  page,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "ended-run",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
    E2E_STATUS: "rolled_back",
    E2E_REASON: "The new admin did not answer its health check.",
    E2E_PHASES: "verify,backup,migrations,roll,health,rollback,finish",
  });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "rolled_back");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    `v${LATEST} did not pass its test. Caelo switched back to`,
  );
  await expect(page.getByTestId("open-install-dialog")).toHaveText("Try again…");
  await expectOnlyAction(page, "open-install-dialog");
});

/**
 * Show this browser an install without the converge job (#819; test-only
 * cookie, lib/server/upgrader.ts): set up before the job existed, or with no
 * caelo-provisioner to run it as.
 */
async function withoutConvergeJob(page: Page, baseURL: string | undefined): Promise<void> {
  await page
    .context()
    .addCookies([
      { name: "caelo_e2e_converge_job", value: "absent", url: baseURL ?? "http://localhost:4173" },
    ]);
}

test("break_glass: without the converge job, a run that needs Cloud Shell shows only the Cloud Shell step", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "needs-shell",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await withoutConvergeJob(page, baseURL);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "break_glass");
  await expect(page.getByTestId("update-state-sentence")).toContainText("Google Cloud Shell");
  await expect(page.getByTestId("update-state-detail")).toContainText("infrastructure contract");
  // Never an Install button next to the Cloud Shell step for the same release.
  await expectOnlyAction(page, "open-cloud-shell");
  // #816 — one button to the release's UPGRADE walkthrough (never the
  // install wizard) and one verified ./run.sh line, no pasted installer.
  const shell = page.getByTestId("open-cloud-shell");
  await expect(shell).toHaveAttribute(
    "href",
    new RegExp(
      `^https://shell\\.cloud\\.google\\.com/cloudshell/editor\\?.*cloudshell_git_branch=release-v${LATEST}&cloudshell_tutorial=upgrade-gcp\\.md$`,
    ),
  );
  await expect(card(page).getByTestId("cloud-shell-command")).toHaveCount(1);
  await expect(card(page).getByTestId("cloud-shell-command")).toHaveText(SHELL_COMMAND);
  await expect(card(page)).not.toContainText("bun.sh");
  await expect(card(page)).not.toContainText("paste these");
  await expect(card(page)).not.toContainText("skip-verify");
  // The refused run never reads "Finished".
  await page.getByTestId("last-attempt").locator("summary").click();
  await expect(page.getByTestId("last-attempt").locator('[data-phase="finish"]')).toContainText(
    "Stopped before changing anything",
  );
});

test("break_glass: without the converge job, a release that changes the cloud setup is recognised before the click (#817)", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "converge-predicted", E2E_EMAIL: REVIEWER_EMAIL });
  await withoutConvergeJob(page, baseURL);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "break_glass");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    `v${LATEST} also changes settings in your Google Cloud project`,
  );
  await expectOnlyAction(page, "open-cloud-shell");
  // #816 — the card never links the install walkthrough.
  await expect(page.getByTestId("open-cloud-shell")).toHaveAttribute(
    "href",
    /cloudshell_tutorial=upgrade-gcp\.md$/,
  );
  // No job was started: nothing in the history.
  await expect(page.getByTestId("section-history")).toHaveCount(0);
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

test("#819: with the converge job, a cloud-setup release installs from here like any other", async ({
  page,
}) => {
  // The upgrader handed the release back (infra-contract): the converge job
  // takes it, so the page offers Install, never Cloud Shell.
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "needs-shell",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "update_available");
  await expectOnlyAction(page, "open-install-dialog");

  // Predicted before any click (#817): Install too, with what to expect.
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "converge-predicted", E2E_EMAIL: REVIEWER_EMAIL });
  await page.reload();
  await expect(card(page)).toHaveAttribute("data-state", "update_available");
  await expect(page.getByTestId("update-state-detail")).toContainText("takes a little longer");
  await expectOnlyAction(page, "open-install-dialog");
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

test("a stale Cloud Shell request for an older release stays in the history (#817)", async ({
  page,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "stale-shell", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "update_available");
  await expectOnlyAction(page, "open-install-dialog");
  await expect(page.getByTestId("history-line")).toContainText("2 entries");
  await openSection(page, "section-history");
  await expect(page.getByTestId("update-history")).toContainText("No longer needed");
  await expect(page.getByTestId("update-history")).toContainText("Needs Cloud Shell");
});

test("scheduled: names when it installs by itself, and offers Install now", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-reset", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-on", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "auto-status",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "scheduled");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    `v${LATEST} installs automatically on`,
  );
  await expect(page.getByTestId("open-install-dialog")).toHaveText("Install now…");
  await expectOnlyAction(page, "open-install-dialog");

  // Paused after the scheduler decided: the page no longer promises the time.
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-pause", E2E_EMAIL: REVIEWER_EMAIL });
  await page.reload();
  await expect(card(page)).toHaveAttribute("data-state", "update_available");
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-reset", E2E_EMAIL: REVIEWER_EMAIL });
});

test("up_to_date: no action, Check now as a small link", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "latest-is-installed", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "up_to_date");
  await expect(page.getByTestId("update-state-badge")).toHaveText("Up to date");
  await expect(page.getByTestId("update-state-sentence")).toHaveText(
    "Your site runs the newest version of Caelo.",
  );
  await expectOnlyAction(page, "none");
  await expect(page.getByTestId("check-releases-now")).toHaveText("Check now");
  await expect(page.getByTestId("section-other-ways")).toHaveCount(0);
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

test("#819: a converge whose next run never started offers Continue, confirmed with the password", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "converge-stalled",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  // The (stand-in) converge job has no live run (test-only cookie,
  // lib/server/upgrader.ts) — Continue must not wait for the 90-minute
  // stale cut-off.
  await page
    .context()
    .addCookies([
      { name: "caelo_e2e_upgrader_run", value: "ended", url: baseURL ?? "http://localhost:4173" },
    ]);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");

  await expect(card(page)).toHaveAttribute("data-state", "interrupted");
  await expect(page.getByTestId("update-state-sentence")).toContainText(
    "picks up where it stopped",
  );
  await expectOnlyAction(page, "continue-update");
  await page.getByTestId("continue-update").click();
  let dialog = page.getByTestId("continue-dialog");
  await expect(dialog).toContainText(`Continue the update to v${LATEST}?`);
  await expect(dialog).toContainText("backup");

  // A wrong password is refused in the dialog; nothing is started.
  await dialog.getByTestId("continue-dialog-password").fill("not the password");
  await dialog.getByTestId("continue-dialog-submit").click();
  dialog = page.getByTestId("continue-dialog");
  await expect(dialog.getByTestId("continue-dialog-error")).toContainText("Wrong password");
  await expect(page.getByTestId("update-timeline")).not.toContainText("Continued by the Owner");

  // The right one continues: the timeline names it and the job's new run.
  await dialog.getByTestId("continue-dialog-password").fill(OWNER_PASSWORD);
  await dialog.getByTestId("continue-dialog-submit").click();
  const timeline = page.getByTestId("update-timeline");
  await expect(timeline).toContainText("Continued by the Owner", { timeout: 15_000 });
  await expect(timeline).toContainText("started (run e2e-upgrader-");

  await page.context().clearCookies({ name: "caelo_e2e_upgrader_run" });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

/** Show this browser a self-hosted install (test-only cookie, lib/server/upgrader.ts). */
async function asSelfHosted(page: Page, baseURL: string | undefined): Promise<void> {
  await page.context().addCookies([
    {
      name: "caelo_e2e_updates_provider",
      value: "self-hosted",
      url: baseURL ?? "http://localhost:4173",
    },
  ]);
}

const SELF_HOSTED_COMMAND = `bunx @caelo-cms/provisioning@${LATEST} upgrade --version ${LATEST}`;

test("self-hosted without a running update agent: agent setup + the server command", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "agent-beat", E2E_EMAIL: REVIEWER_EMAIL });
  await asSelfHosted(page, baseURL);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");

  const installed = ((await page.getByTestId("installed-version").textContent()) ?? "").slice(1);
  await expect(page.getByTestId("agent-setup")).toBeVisible();
  await expect(page.getByTestId("agent-state")).toContainText("not set up");
  await expect(page.getByTestId("agent-install-command")).toHaveText(
    `bunx @caelo-cms/provisioning@${installed} agent install`,
  );
  await expect(page.getByTestId("install-update")).toHaveCount(0);
  // The hand-run upgrade is the card's one action: on the server, no --install.
  await expectOnlyAction(page, "upgrade-command");
  await expect(card(page).getByTestId("upgrade-command")).toHaveText(SELF_HOSTED_COMMAND);
  await expect(page.getByTestId("upgrade-instructions")).toContainText("holds .caelo/");

  // An agent that stopped checking in, or reports a problem, gets no button either.
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "agent-beat",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_AGENT_MINUTES: "30",
  });
  await page.reload();
  await expect(page.getByTestId("agent-state")).toContainText("not running now");
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "agent-beat",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_AGENT_MINUTES: "0",
    E2E_AGENT_PROBLEM: "cosign is not installed on the server.",
  });
  await page.reload();
  await expect(page.getByTestId("agent-state")).toContainText("cosign is not installed");
  await expect(page.getByTestId("install-update")).toHaveCount(0);
});

test("self-hosted with the agent checking in: Install update queues the request for it", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "agent-beat",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_AGENT_MINUTES: "0",
  });
  await asSelfHosted(page, baseURL);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");

  await expect(page.getByTestId("agent-setup")).toHaveCount(0);
  await expect(page.getByTestId("install-update")).toContainText("update agent on your server");
  await page.getByTestId("open-install-dialog").click();
  const dialog = page.getByTestId("install-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("picks it up within a minute");
  await dialog.getByTestId("install-dialog-password").fill(OWNER_PASSWORD);
  await dialog.getByTestId("install-dialog-submit").click();

  // Queued for the agent; nothing was started by the admin itself.
  const timeline = card(page).getByTestId("update-timeline");
  await expect(timeline).toContainText(`→ v${LATEST}`);
  await expect(page.getByTestId("update-status")).toHaveText("Waiting to start");
  await expect(timeline).toContainText("Upgrader started (run agent@e2e-box)");
});

test("self-hosted: a release the agent cannot install shows the server step", async ({
  page,
  baseURL,
}) => {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "needs-server",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await asSelfHosted(page, baseURL);
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "break_glass");
  await expect(page.getByTestId("update-state-sentence")).toContainText("on your server");
  await expect(page.getByTestId("update-state-detail")).toContainText(
    "upgrade command on the server",
  );
  await expectOnlyAction(page, "upgrade-command");
  await page.getByTestId("last-attempt").locator("summary").click();
  await expect(page.getByTestId("update-status")).toHaveText("Needs a manual upgrade");
  await expect(page.getByTestId("cloud-shell-upgrade")).toHaveCount(0);
});

/** Confirm the open policy dialog with a password (the owner's by default). */
async function confirmPolicy(page: Page, password = OWNER_PASSWORD): Promise<void> {
  const dialog = page.getByTestId("policy-dialog");
  await dialog.getByTestId("policy-dialog-password").fill(password);
  await dialog.getByTestId("policy-dialog-submit").click();
}

test("Automatic updates: collapsed with a summary; each change confirmed with the password", async ({
  page,
}) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-reset", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");

  // The one-line summary: mode + the missing email service (a plain text in
  // the summary; the link sits in the opened section — a link inside a
  // <summary> is a nested interactive control, axe "nested-interactive").
  const line = page.getByTestId("auto-update-line");
  await expect(line).toContainText("You're notified and install updates yourself.");
  await expect(line).toContainText("Email not set up");
  await expect(line.locator("a")).toHaveCount(0);

  await openSection(page, "section-auto-updates");
  await expect(page.getByTestId("setup-email")).toHaveAttribute("href", "/settings/email");
  const policyCard = page.getByTestId("auto-update-policy");
  const summary = policyCard.getByTestId("auto-update-summary");
  await expect(summary).toContainText("install it yourself");
  // One choice (#862): no "Don't tell me", no "Used only when" hint; the
  // kinds appear only under "Install automatically".
  await expect(policyCard).not.toContainText("Don't tell me");
  await expect(policyCard).not.toContainText("Used only when");
  await expect(policyCard.getByTestId("policy-mode-notify")).toBeChecked();
  await expect(policyCard.getByTestId("policy-auto-kinds")).toBeHidden();
  await policyCard.getByTestId("policy-mode-auto").check();
  await expect(policyCard.getByTestId("policy-auto-kinds")).toBeVisible();
  await policyCard.getByTestId("policy-auto-patch").check();
  await policyCard.getByTestId("policy-auto-converge").check();
  await expect(policyCard.getByTestId("policy-auto-converge-hint")).toContainText("same wait");
  // Window and waiting times live under the collapsed "More settings".
  await expect(policyCard.getByTestId("policy-window-enabled")).toBeHidden();
  await policyCard.getByText("More settings").click();
  await policyCard.getByTestId("policy-window-enabled").check();
  await policyCard.getByLabel("From", { exact: true }).fill("02:00");
  await policyCard.getByLabel("To", { exact: true }).fill("05:00");
  await policyCard.getByLabel("Time zone").fill("Europe/Berlin");
  await policyCard.getByLabel("Wait after a release (hours)").fill("48");
  await policyCard.getByLabel("Wait for security fixes (hours)").fill("4");
  // Each kind shows its current waiting time.
  await expect(policyCard.getByTestId("policy-auto-kinds")).toContainText("after 48 hours");
  await policyCard.getByTestId("save-policy").click();

  // A wrong password is refused in the dialog and keeps what was typed.
  await confirmPolicy(page, "not the password");
  await expect(page.getByTestId("policy-dialog-error")).toContainText("Wrong password");
  await expect(policyCard.getByLabel("Wait after a release (hours)")).toHaveValue("48");
  await expect(summary).toContainText("install it yourself");
  await confirmPolicy(page);

  await expect(summary).toContainText("Installed automatically: bug fixes.");
  await expect(summary).toContainText("Google Cloud project install automatically too");
  await expect(summary).toContainText("Only between 02:00 and 05:00 (Europe/Berlin).");
  await expect(summary).toContainText("waits 48 hours");
  await expect(line).toContainText("Installs bug-fix releases automatically.");

  // Pause for a week, with a reason — its own password confirmation.
  await policyCard.getByLabel("Pause automatic updates", { exact: true }).selectOption("7");
  await policyCard.getByLabel("Why (optional)").fill("Launch week");
  await policyCard.getByTestId("pause-auto-updates").click();
  await confirmPolicy(page);
  const paused = policyCard.getByTestId("auto-update-paused");
  await expect(paused).toContainText("Automatic updates paused until");
  await expect(paused).toContainText("Launch week");

  // Resume: again its own confirmation.
  await policyCard.getByTestId("resume-auto-updates").click();
  await confirmPolicy(page);
  await expect(policyCard.getByTestId("auto-update-paused")).toHaveCount(0);

  // "Notify only" keeps the ticked kinds stored: switching back shows them.
  await policyCard.getByTestId("policy-mode-notify").check();
  await expect(policyCard.getByTestId("policy-auto-kinds")).toBeHidden();
  await policyCard.getByTestId("save-policy").click();
  await confirmPolicy(page);
  await expect(summary).toContainText("security fixes included, and install it yourself");
  await page.reload();
  await openSection(page, "section-auto-updates");
  await expect(policyCard.getByTestId("policy-mode-notify")).toBeChecked();
  await policyCard.getByTestId("policy-mode-auto").check();
  await expect(policyCard.getByTestId("policy-auto-patch")).toBeChecked();
  await expect(policyCard.getByTestId("policy-auto-converge")).toBeChecked();
  await expect(policyCard.getByTestId("policy-auto-minor")).not.toBeChecked();

  // What the scheduler decided, and the emails it could not send.
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "auto-status",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_LATEST: LATEST,
  });
  await page.reload();
  await openSection(page, "section-auto-updates");
  await expect(policyCard.getByTestId("auto-update-status")).toContainText("waiting");
  await expect(policyCard.getByTestId("auto-update-status")).toContainText("out for 48 hours");
  await expect(policyCard.getByTestId("update-email-missing")).toBeVisible();
  await expect(policyCard.getByTestId("update-emails")).toContainText(
    "Caelo v99.0.0 will install automatically",
  );
  await expect(policyCard.getByTestId("update-emails")).toContainText("Not sent: no email set up");
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "auto-reset", E2E_EMAIL: REVIEWER_EMAIL });
});

test("a Reviewer reads the automatic-update policy but cannot change it", async ({ page }) => {
  await login(page, REVIEWER_EMAIL, REVIEWER_PASSWORD);
  await page.goto("/settings/updates");
  await openSection(page, "section-auto-updates");
  const policyCard = page.getByTestId("auto-update-policy");
  await expect(policyCard.getByTestId("auto-update-summary")).toBeVisible();
  await expect(policyCard.getByTestId("policy-form")).toHaveCount(0);
  await expect(policyCard.getByTestId("save-policy")).toHaveCount(0);
  // Settings → Email needs settings.write: no link the Reviewer can't follow.
  await expect(page.getByTestId("email-not-set-up")).toContainText(
    "Ask an Owner of this site to set one up.",
  );
  await expect(page.getByTestId("setup-email")).toHaveCount(0);
});

test("unknown: a two-day-old check no longer claims 'Up to date'", async ({ page }) => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "stale-up-to-date", E2E_EMAIL: REVIEWER_EMAIL });
  await login(page, "dev-owner@example.com", OWNER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("update-state-badge")).toHaveText("Check out of date");
  await expect(page.getByTestId("update-state-sentence")).toHaveText(
    "Caelo last checked for new releases 2 days ago, so it may not know about a newer one.",
  );
  await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
  await expectOnlyAction(page, "none");
  await expect(card(page).getByTestId("check-releases-now")).toHaveCount(1);
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "reset-install", E2E_EMAIL: REVIEWER_EMAIL });
});

test("unknown: a failed check is never 'Up to date'; Check now refreshes it", async ({ page }) => {
  // A failed hourly check 5 minutes ago: never "Up to date".
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "checked-ago",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_MINUTES: "5",
    E2E_LATEST: "",
  });
  // A Reviewer may read the page, so may refresh what it shows.
  await login(page, REVIEWER_EMAIL, REVIEWER_PASSWORD);
  await page.goto("/settings/updates");
  await expect(card(page)).toHaveAttribute("data-state", "unknown");
  await expect(page.getByTestId("update-state-badge")).toHaveText("Last check failed");
  await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("release-checked-at")).toHaveText("checked 5 min ago");
  await expect(page.getByTestId("update-state-sentence")).toContainText("couldn't reach GitHub");
  // Check now is this state's one primary action (a button, not the small link).
  await expect(page.getByTestId("check-releases-now")).toHaveCount(1);

  // The hourly check found the release 40 minutes ago.
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "checked-ago",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_MINUTES: "40",
    E2E_LATEST: LATEST,
  });
  await page.reload();
  await expect(page.getByTestId("release-checked-at")).toHaveText("checked 40 min ago");

  // Check now (the small link): asks (the stand-in for) GitHub right away.
  await page.getByTestId("check-releases-now").click();
  await expect(
    page.getByText(`Checked GitHub just now: the newest release is v${LATEST}.`),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("release-checked-at")).toHaveText("checked just now");
  await expect(page.getByTestId("latest-version")).toHaveText(`v${LATEST}`);
  await expect(page.getByTestId("release-notes")).toContainText(
    "A fix reported by the e2e release-check stand-in",
  );

  // A second click within the minute is refused, and says so.
  await page.getByTestId("check-releases-now").click();
  await expect(page.getByTestId("release-check-error")).toContainText(
    "checked for new releases less than a minute ago",
  );
});
