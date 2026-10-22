// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #806 / #968 — Settings → MCP "Connected apps": one row per app a
 * person connected by URL. Seeds two apps of one throwaway editor (the rows
 * their first remote requests would create), then pins:
 *
 *   - the Owner revokes one app and the editor's other app stays active
 *     (the viu.one case: revoking Claude Code locked out ChatGPT), with who
 *     revoked it; Restore; the cap round-trip;
 *   - "Block all apps" and Unblock for the person;
 *   - the editor sees only their own apps, read-only, and no token section.
 *
 * The remote endpoints themselves are covered by
 * apps/admin/src/lib/server/mcp-remote.integration.test.ts (IAP cannot be
 * reproduced in the compose stack), including the editor's permission error
 * on the admin address.
 */

import { expect, type Page, test } from "@playwright/test";
import { acceptConfirm, clearLoginRateBucket, runBunInline } from "./helpers.js";

const EMAIL = `e2e-remote-${Date.now()}@example.test`;
const PASSWORD = "e2e remote editor password";
const CHATGPT = "https://chatgpt.com/oauth/client.json";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    import { hashPassword } from "@caelo-cms/admin-core";
    const passwordHash = await hashPassword(process.env.PASSWORD);
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${process.env.EMAIL}) RETURNING id::text AS id\`;
      const id = actor[0].id;
      await tx\`INSERT INTO users (id, email, password_hash, onboarded_at)
               VALUES (\${id}::uuid, \${process.env.EMAIL}, \${passwordHash}, now())\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) SELECT \${id}::uuid, r.id FROM roles r WHERE r.name = 'editor'\`;
      await tx\`INSERT INTO mcp_remote_connections (actor_id, surface, client_key, client_label, last_used_at)
               VALUES (\${id}::uuid, 'chat', 'dcr:Claude Code', 'claude-code', now()),
                      (\${id}::uuid, 'chat', \${process.env.CHATGPT}, 'openai-mcp', now())\`;
    });
    await sql.end();
    `,
    { EMAIL, PASSWORD, CHATGPT },
  );
});

async function signIn(page: Page, email: string, password: string): Promise<void> {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

function person(page: Page) {
  return page.getByTestId("mcp-remote-person").filter({ hasText: EMAIL });
}

test("the Owner revokes one app and the person's other app keeps working", async ({ page }) => {
  await signIn(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/mcp");
  const rows = person(page).getByTestId("mcp-remote-row");
  const claude = rows.filter({ hasText: "Claude Code" });
  const chatgpt = rows.filter({ hasText: "ChatGPT" });
  await expect(rows).toHaveCount(2);
  await expect(claude).toContainText("active");
  await expect(chatgpt).toContainText("active");

  await claude.getByRole("button", { name: "Revoke" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Remote connection updated.")).toBeVisible();
  await expect(claude).toContainText("revoked");
  await expect(claude).toContainText("by dev-owner@example.com");
  await expect(chatgpt).toContainText("active");

  await claude.getByRole("button", { name: "Restore" }).click();
  await expect(claude).toContainText("active");

  await chatgpt.getByLabel("Cap in microcents (blank = uncapped)").fill("2500000");
  await chatgpt.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Remote connection updated.")).toBeVisible();
  await expect(chatgpt.getByLabel("Cap in microcents (blank = uncapped)")).toHaveValue("2500000");
});

test("the Owner blocks every app of a person and lifts the block", async ({ page }) => {
  await signIn(page, "dev-owner@example.com", "dev owner password");
  await page.goto("/settings/mcp");
  await person(page).getByRole("button", { name: "Block all apps" }).click();
  await acceptConfirm(page);
  await expect(person(page)).toContainText("all apps blocked");
  const rows = person(page).getByTestId("mcp-remote-row");
  await expect(rows.filter({ hasText: "blocked" })).toHaveCount(2);

  await person(page).getByRole("button", { name: "Unblock" }).click();
  await expect(person(page)).not.toContainText("all apps blocked");
  await expect(rows.filter({ hasText: "active" })).toHaveCount(2);
});

test("an editor sees only their own apps, read-only, and no token section", async ({ page }) => {
  await signIn(page, EMAIL, PASSWORD);
  await page.goto("/settings/mcp");
  const card = page.getByTestId("mcp-remote-connections");
  await expect(card.getByText("Your connected apps")).toBeVisible();
  await expect(card.getByTestId("mcp-remote-person")).toHaveCount(1);
  await expect(person(page).getByTestId("mcp-remote-row")).toHaveCount(2);
  for (const name of ["Revoke", "Restore", "Save", "Block all apps"]) {
    await expect(card.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(page.getByTestId("mcp-token-access")).toHaveCount(0);
  // Remote MCP is off in the suite: an editor is told to ask an Owner, not offered setup.
  const remote = page.getByTestId("mcp-remote-access");
  await expect(remote).toContainText("Ask an Owner to set it up.");
  await expect(remote.getByRole("link", { name: "Set up remote MCP" })).toHaveCount(0);
});
