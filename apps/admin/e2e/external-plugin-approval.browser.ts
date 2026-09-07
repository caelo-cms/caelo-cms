// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { runBunInline } from "./helpers.js";

const submitScript = `
  import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
  import { registerAdminOps } from "@caelo-cms/admin-core";
  const adapter = new DatabaseAdapter({adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL});
  const registry = new OperationRegistry(); registerAdminOps(registry);
  const ctx = {actorKind:"system", actorId:"00000000-0000-0000-0000-00000000ffff", requestId:"external-e2e-submit"};
  const r = await execute(registry, adapter, ctx, "plugins.submit", JSON.parse(process.env.PLUGIN_INPUT));
  await adapter.close();
  if (!r.ok) throw new Error(JSON.stringify(r.error));
`;

test("Owner reviews exact external source; stale approval is rejected", async ({ page }) => {
  const slug = `e2e-external-${Date.now()}`;
  const manifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    operations: ["read"],
    hasStaticRender: false,
  };
  const source = `export default {slug:"${slug}",version:"1.0.0",tier:2,schema:{},operations:{read:async()=>"hello"}};`;
  const input = { slug, version: "1.0.0", manifest, source };
  runBunInline(submitScript, { PLUGIN_INPUT: JSON.stringify(input) });
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  await page.goto("/security/plugins");
  const row = page.getByRole("row").filter({ hasText: slug });
  await row.getByText("Review package").click();
  await expect(row.locator("pre").last()).toHaveText(source);
  runBunInline(submitScript, {
    PLUGIN_INPUT: JSON.stringify({ ...input, source: `${source}\n// updated` }),
  });
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByText("This plugin changed since you opened the page.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByRole("main").getByText(`Activated ${slug}.`, { exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    page.getByRole("main").getByText(`Disabled ${slug}.`, { exact: true }),
  ).toBeVisible();
});
