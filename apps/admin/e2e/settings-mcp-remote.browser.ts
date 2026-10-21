// SPDX-License-Identifier: MPL-2.0

/**
 * #806 / #914 — Settings → MCP → Remote without Google: the suite runs the
 * admin with CAELO_E2E_GOOGLE_IAP=1 (a gcp-firebase install's env; every
 * Google call fails). Remote MCP has no client of its own any more: the page
 * points at Settings → Google sign-in for it, and keeps the MCP-specific
 * parts — whether it is on, and every client's URL form.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const GATEWAY = "https://caelo-production-gateway-e2e-ew.a.run.app";

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

test("the MCP page says remote MCP is off and leads the Owner to its setup", async ({ page }) => {
  await page.goto("/settings/mcp");
  // #968 — state-aware: off here (no Google sign-in client), so setup is offered.
  const card = page.getByTestId("mcp-remote-access");
  await expect(card).toHaveAttribute("data-state", "off");
  await expect(card.getByTestId("mcp-remote-access-status")).toHaveText("Off");
  await card.getByRole("link", { name: "Set up remote MCP" }).click();
  await expect(page).toHaveURL("/settings/google-sign-in");
});

test("remote MCP uses the install's Google sign-in and sends the Owner there to set it up", async ({
  page,
}) => {
  await page.goto("/settings/mcp/remote");
  await expect(page.getByTestId("remote-mcp-sign-in")).toContainText(
    "Remote MCP uses this install's Google sign-in",
  );
  // No second client: the paste form lives only under Settings → Google sign-in.
  await expect(page.getByLabel("Client secret")).toHaveCount(0);
  await page.getByTestId("remote-mcp-sign-in-link").click();
  await expect(page).toHaveURL("/settings/google-sign-in");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("gives every client the MCP URL in its own form", async ({ page }) => {
  await page.goto("/settings/mcp/remote");
  const setup = page.getByTestId("remote-mcp-client-setup");
  await expect(page.getByTestId("remote-mcp-url")).toHaveText(`${GATEWAY}/api/mcp/chat`);

  await setup.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByTestId("remote-mcp-setup-claude-code")).toHaveText(
    `claude mcp add --transport http caelo ${GATEWAY}/api/mcp/chat`,
  );

  await expect(page.getByTestId("remote-mcp-connector-name")).toContainText("(Chat)");
  await setup.getByLabel("What should the AI tool get?").selectOption("admin");
  await expect(page.getByTestId("remote-mcp-url")).toHaveText(`${GATEWAY}/api/mcp/admin`);
  // #968 — a name that keeps the admin connector apart from the chat one.
  await expect(page.getByTestId("remote-mcp-connector-name")).toContainText("(Admin)");
  await expect(page.getByTestId("remote-mcp-setup-claude-code")).toContainText("caelo-admin");

  const tabs: Array<[string, string, string]> = [
    ["Codex CLI", "remote-mcp-setup-codex", "codex mcp login caelo-admin"],
    ["Cursor", "remote-mcp-setup-cursor", '"url"'],
    ["VS Code", "remote-mcp-setup-vscode", '"type": "http"'],
    ["Gemini CLI", "remote-mcp-setup-gemini", '"httpUrl"'],
  ];
  for (const [tab, testid, marker] of tabs) {
    await setup.getByRole("tab", { name: tab }).click();
    const snippet = page.getByTestId(testid);
    await expect(snippet).toContainText(marker);
    await expect(snippet).toContainText(`${GATEWAY}/api/mcp/admin`);
    await expect(snippet).not.toContainText("TOKEN");
  }
  await setup.getByRole("tab", { name: "ChatGPT" }).click();
  await expect(setup).toContainText("Developer mode");
});
