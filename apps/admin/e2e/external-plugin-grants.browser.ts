// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

// Every spec logs in as dev-owner from the same IP; the login limiter
// (5 per 5 min) would otherwise reject later specs in the batch.
test.beforeAll(clearLoginRateBucket);
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
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools", "companion_skills"],
    skills: [
      {
        slug: `${slug}-guide`,
        displayName: `Guide ${slug}`,
        description: "Read private notes",
        body: "Use the private notes tool in author chat.",
        allowlistedTools: [toolName],
      },
    ],
    capabilityReasons: {
      companion_skills: "Teach the authoring workflow",
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
  await page.getByLabel("Plugin package (.json, .json.gz or .json.br)").setInputFiles({
    name: "notes.caelo-plugin.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ manifest, source })),
  });
  await page.getByRole("button", { name: "Submit package for review" }).click();
  const review = page.getByTestId(`installation-${slug}`);
  await expect(review).toContainText("Review: pending");
  await review.getByText("Review package source and manifest").click();
  await expect(review.locator("pre").nth(1)).toHaveText(source);
  // What the AI will be told about each tool is shown in plain text before approval.
  const toolList = review.getByTestId(`installation-tools-${slug}`);
  await expect(toolList).toContainText(toolName);
  await expect(toolList).toContainText("Read private notes");
  // So are the instructions the plugin would give the AI.
  const skillList = review.getByTestId(`installation-skills-${slug}`);
  await expect(skillList).toContainText(`Guide ${slug}`);
  await skillList.getByText("Full instructions").click();
  await expect(skillList).toContainText("Use the private notes tool in author chat.");
  const privateAccess = review.getByRole("checkbox", { name: /cms_admin_schema/ });
  const tools = review.getByRole("checkbox", { name: /chat_runner_tools/ });
  const companion = review.getByRole("checkbox", { name: /companion_skills/ });
  await expect(companion).not.toBeChecked();
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
  await companion.check();
  await review.getByRole("button", { name: "Approve selected access and activate" }).click();
  await expect(page.getByRole("status")).toContainText("Approved package is running.");
  await expect(review).toContainText("Review: active");
  await page.goto("/security/skills");
  await expect(page.getByText(`Guide ${slug}`, { exact: true })).toBeVisible();
  await page.goto("/security/plugins/installations");
  await review.getByRole("button", { name: "Revoke cms_admin_schema", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Access revoked. The plugin is disabled; its data is preserved.",
  );
  await expect(review).toContainText("Current plugin: disabled");
  await page.goto("/security/skills");
  await expect(page.getByText(`Guide ${slug}`, { exact: true })).toHaveCount(0);
});
