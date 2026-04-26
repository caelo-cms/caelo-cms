// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { runBunInline } from "./helpers.js";

/**
 * Reviewer role has `content.read` but not `content.write`. They can browse
 * the content tree; every mutation surface returns 403.
 *
 * Playwright runs under Node — we cannot `import { SQL } from "bun"` here. The
 * Reviewer fixture is therefore provisioned by spawning a small Bun subprocess
 * that uses Bun's native SQL driver. Mirrors the pattern from the dev-owner
 * seed script to keep test setup independent of the user-management UI flow.
 *
 * Values flow into the subprocess via env vars and are bound through Bun's
 * tagged-template SQL parameteriser so quoting is correct — splicing strings
 * into the script source confuses Postgres' identifier vs literal parsing.
 */

const ts = Date.now();
const REVIEWER_EMAIL = `e2e-reviewer-${ts}@example.com`;
const REVIEWER_PASSWORD = "reviewer dev password";

const FIXTURE_SCRIPT = `
  import { SQL } from "bun";
  const op = process.env.E2E_OP;
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  if (op === "seed") {
    const { hashPassword } = await import("@caelo/admin-core");
    const pwd = await hashPassword(password);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = await tx\`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'E2E Reviewer')
        RETURNING id::text AS id
      \`;
      const actorId = actor[0]?.id;
      if (!actorId) throw new Error("seed actor returned no row");
      await tx\`
        INSERT INTO users (id, email, password_hash, is_first_owner)
        VALUES (\${actorId}::uuid, \${email}, \${pwd}, false)
      \`;
      await tx\`
        INSERT INTO user_roles (user_id, role_id)
        SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'reviewer'
      \`;
    });
  } else if (op === "wipe") {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = \${email})\`;
      await tx\`DELETE FROM users WHERE email = \${email}\`;
    });
  } else {
    throw new Error("unknown E2E_OP: " + op);
  }
  await sql.end();
`;

async function seedReviewer(): Promise<void> {
  runBunInline(FIXTURE_SCRIPT, {
    E2E_OP: "seed",
    E2E_EMAIL: REVIEWER_EMAIL,
    E2E_PASSWORD: REVIEWER_PASSWORD,
  });
}

async function wipeReviewer(): Promise<void> {
  runBunInline(FIXTURE_SCRIPT, { E2E_OP: "wipe", E2E_EMAIL: REVIEWER_EMAIL });
}

test.beforeAll(seedReviewer);
test.afterAll(wipeReviewer);

test("Reviewer can read /content but cannot mutate", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(REVIEWER_EMAIL);
  await page.getByLabel("Password").fill(REVIEWER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Reads are allowed.
  await page.goto("/content");
  await expect(page.getByRole("heading", { name: "Content" })).toBeVisible();
  await page.goto("/content/modules");
  await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible();

  // CSRF token is still rendered (the layout exposes it for any authenticated user).
  const csrf = (await page.locator('input[name="_csrf"]').first().getAttribute("value")) ?? "";
  expect(csrf).not.toBe("");
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // Mutations return 403 — `requirePermission(locals, 'content.write')` throws
  // before the handler runs.
  const body = new URLSearchParams();
  body.set("_csrf", csrf);
  body.set("slug", `e2e-reviewer-mod-${ts}`);
  body.set("displayName", "Should not create");
  body.set("html", "<p>nope</p>");
  const res = await request.post("/content/modules?/create", {
    headers: {
      cookie: cookieHeader,
      origin: "http://localhost:4173",
      "content-type": "application/x-www-form-urlencoded",
    },
    data: body.toString(),
    maxRedirects: 0,
  });
  expect(res.status()).toBe(403);
});
