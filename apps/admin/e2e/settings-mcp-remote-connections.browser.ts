// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — Settings → MCP "Remote connections": the Owner sees who
 * connected through a remote MCP client and controls it. Seeds a remote
 * connection for a throwaway editor (the row a first remote request would
 * create), then pins Revoke → revoked + Restore, Restore → active, and the
 * cap round-trip. The remote endpoints themselves are covered by
 * apps/admin/src/lib/server/mcp-remote.integration.test.ts (IAP cannot be
 * reproduced in the compose stack).
 */

import { expect, test } from "@playwright/test";
import { acceptConfirm, clearLoginRateBucket, runBunInline } from "./helpers.js";

const EMAIL = `e2e-remote-${Date.now()}@example.test`;

test.beforeAll(() => {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${process.env.EMAIL}) RETURNING id::text AS id\`;
      const id = actor[0].id;
      await tx\`INSERT INTO users (id, email, password_hash) VALUES (\${id}::uuid, \${process.env.EMAIL}, 'e2e-no-login')\`;
      await tx\`INSERT INTO user_roles (user_id, role_id) SELECT \${id}::uuid, r.id FROM roles r WHERE r.name = 'editor'\`;
      await tx\`INSERT INTO mcp_remote_connections (actor_id, surface, client_label, last_used_at)
               VALUES (\${id}::uuid, 'chat', 'claude-ai', now())\`;
    });
    await sql.end();
    `,
    { EMAIL },
  );
});

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

test("the Owner revokes, restores and caps a remote connection", async ({ page }) => {
  await page.goto("/settings/mcp");
  const card = page.getByTestId("mcp-remote-connections");
  await expect(card).toBeVisible();
  const row = card.getByTestId("mcp-remote-row").filter({ hasText: EMAIL });
  await expect(row).toContainText("claude-ai");
  await expect(row).toContainText("active");

  await row.getByRole("button", { name: "Revoke" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Remote connection updated.")).toBeVisible();
  await expect(row).toContainText("revoked");

  await row.getByRole("button", { name: "Restore" }).click();
  await expect(row).toContainText("active");

  await row.getByLabel("Cap in microcents (blank = uncapped)").fill("2500000");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Remote connection updated.")).toBeVisible();
  await expect(row.getByLabel("Cap in microcents (blank = uncapped)")).toHaveValue("2500000");
});
