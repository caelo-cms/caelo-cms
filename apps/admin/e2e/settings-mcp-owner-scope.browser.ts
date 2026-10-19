// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/mcp shows an Owner every user's MCP tokens and everyone else
 * only their own (migration 0315). Pins both sides: the Owner sees a
 * Reviewer's token next to their own; the Reviewer sees only theirs, gets
 * no mint form, and can still revoke their own token.
 *
 * The Reviewer fixture is provisioned by a Bun subprocess (Playwright runs
 * under Node), the same pattern as content-reviewer-readonly.browser.ts.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, mintAdminMcpToken, runBunInline } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const ts = Date.now();
const REVIEWER_EMAIL = `e2e-mcp-reviewer-${ts}@example.com`;
const REVIEWER_PASSWORD = "reviewer dev password";
const REVIEWER_TOKEN = `e2e-reviewer-token-${ts}`;
const OWNER_TOKEN = `e2e-owner-token-${ts}`;

const FIXTURE_SCRIPT = `
  import { SQL } from "bun";
  const op = process.env.E2E_OP;
  const email = process.env.E2E_EMAIL;
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  if (op === "seed") {
    const { hashPassword } = await import("@caelo-cms/admin-core");
    const pwd = await hashPassword(process.env.E2E_PASSWORD);
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = await tx\`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'E2E MCP Reviewer')
        RETURNING id::text AS id
      \`;
      const actorId = actor[0]?.id;
      if (!actorId) throw new Error("seed actor returned no row");
      await tx\`
        INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
        VALUES (\${actorId}::uuid, \${email}, \${pwd}, false, now())
      \`;
      await tx\`
        INSERT INTO user_roles (user_id, role_id)
        SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'reviewer'
      \`;
      return actorId;
    });
    process.stdout.write(id);
  } else if (op === "wipe") {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM mcp_tokens WHERE actor_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM users WHERE email = \${email}\`;
    });
  } else {
    throw new Error("unknown E2E_OP: " + op);
  }
  await sql.end();
`;

test.beforeAll(() => {
  clearLoginRateBucket();
  const reviewerId = runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "seed",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_PASSWORD: REVIEWER_PASSWORD,
  }).trim();
  mintAdminMcpToken(reviewerId, REVIEWER_TOKEN);
});

test.afterAll(() => {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "wipe", E2E_EMAIL: REVIEWER_EMAIL });
});

test("an Owner sees every user's MCP tokens", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/settings/mcp");
  await page.getByLabel("Name").fill(OWNER_TOKEN);
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByTestId("mcp-client-setup")).toBeVisible();

  await page.goto("/settings/mcp");
  await expect(page.getByRole("cell", { name: OWNER_TOKEN, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: REVIEWER_TOKEN, exact: true })).toBeVisible();
});

test("a Reviewer sees and revokes only their own MCP tokens", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(REVIEWER_EMAIL);
  await page.getByLabel("Password").fill(REVIEWER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/settings/mcp");
  await expect(page.getByText("Your tokens", { exact: true })).toBeVisible();
  const own = page.getByRole("row").filter({ hasText: REVIEWER_TOKEN });
  await expect(own).toBeVisible();
  await expect(page.getByRole("cell", { name: OWNER_TOKEN, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create token" })).toHaveCount(0);

  await own.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Token revoked.")).toBeVisible();
  await expect(own.getByText("revoked", { exact: true })).toBeVisible();
});
