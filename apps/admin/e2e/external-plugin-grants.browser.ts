// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

test("Owner uploads a package, explicitly grants each capability, and revokes private access", async ({
  page,
}) => {
  const slug = `e2e-grants-${Date.now()}`;
  const toolName = `${slug.replaceAll("-", "_")}__read`;
  const manifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: { notes: { body: "text" } },
    operations: ["read"],
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"],
    capabilityReasons: {
      cms_admin_schema: "Store unpublished notes",
      chat_runner_tools: "Read notes from author chat",
    },
    tools: [
      {
        name: toolName,
        description: "Read private notes",
        operationName: "read",
        inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
  const source = `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{read:async ctx=>ctx.adminQuery.list("notes")}};`;
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  await page.goto("/security/plugins/installations");
  // Every installation mutation rejects a missing session CSRF token before touching state.
  for (const action of ["stage", "approve", "retry", "revoke"]) {
    const status = await page.evaluate(async (name) => {
      const response = await fetch(`?/${name}`, { method: "POST", body: new FormData() });
      return response.status;
    }, action);
    expect(status).toBe(403);
  }
  await page.getByLabel("Plugin package (.json)").setInputFiles({
    name: "notes.caelo-plugin.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ manifest, source })),
  });
  await page.getByRole("button", { name: "Submit package for review" }).click();
  const review = page.getByTestId(`installation-${slug}`);
  await expect(review).toContainText("Review: pending");
  await review.getByText("Review package source and manifest").click();
  await expect(review.locator("pre").nth(1)).toHaveText(source);
  const privateAccess = review.getByRole("checkbox", { name: /cms_admin_schema/ });
  const tools = review.getByRole("checkbox", { name: /chat_runner_tools/ });
  await expect(privateAccess).not.toBeChecked();
  await expect(tools).not.toBeChecked();
  // Bypass browser required-field validation to prove server-side enforcement too.
  await review.locator("input[required]").evaluateAll((elements) =>
    elements.forEach((element) => {
      element.removeAttribute("required");
    }),
  );
  await privateAccess.check();
  await review.getByRole("button", { name: "Approve selected access and activate" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Select every requested capability explicitly",
  );
  await privateAccess.check();
  await tools.check();
  await review.getByRole("button", { name: "Approve selected access and activate" }).click();
  await expect(page.getByRole("status")).toContainText("Approved package is running.");
  await expect(review).toContainText("Review: active");
  await review.getByRole("button", { name: "Revoke cms_admin_schema", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Access revoked. The plugin is disabled; its data is preserved.",
  );
  await expect(review).toContainText("Current plugin: disabled");
});
