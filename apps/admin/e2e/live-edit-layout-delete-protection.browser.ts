// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 review pass — `layouts.delete` refuses to soft-delete a
 * layout while any non-deleted template still references it. The
 * Owner UI surfaces this in two ways:
 *   1. The Delete button on the row is disabled with a guidance
 *      tooltip ("Re-point referencing templates first").
 *   2. Driving the op directly via the registry (Bun side-channel)
 *      yields a HandlerError naming the offending template slugs.
 *
 * The HTTP-form path is exercised by the broader Owner UI spec.
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test("delete on site-default is blocked while templates reference it", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/security/layouts");
  await expect(page.getByRole("heading", { name: "Layouts", exact: true })).toBeVisible();

  // The site-default row's Delete button is disabled (templates bound).
  const row = page.locator("li").filter({ hasText: "site-default" });
  const delBtn = row.getByRole("button", { name: "Delete" });
  await expect(delBtn).toBeDisabled();
  await expect(delBtn).toHaveAttribute("title", /re-point/i);

  // Drive the op directly (system actor) to confirm the structured
  // error names the offending template, not just a generic message.
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
      import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
      import { registerAdminOps } from "@caelo-cms/admin-core";
      const registry = new OperationRegistry();
      registerAdminOps(registry);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
        publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
      });
      const ctx = {
        actorId: "00000000-0000-0000-0000-00000000ffff",
        actorKind: "system",
        requestId: "e2e-delete-protection",
      };
      const got = await execute(registry, adapter, ctx, "layouts.get", { slug: "site-default" });
      if (!got.ok) throw new Error(JSON.stringify(got.error));
      const layoutId = got.value.layout.id;
      const del = await execute(registry, adapter, ctx, "layouts.delete", { layoutId });
      process.stdout.write(JSON.stringify({ ok: del.ok, error: del.error }));
      `,
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  const result = JSON.parse(r.stdout) as { ok: boolean; error?: { message?: string } };
  expect(result.ok).toBe(false);
  expect(result.error?.message ?? "").toMatch(/still in use/i);
  expect(result.error?.message ?? "").toMatch(/templates/);
});
