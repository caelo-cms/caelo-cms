// SPDX-License-Identifier: MPL-2.0

/**
 * /settings/mcp after minting a token: the operator gets setup for every
 * supported client, not just a Claude Code command. Pins that each tab
 * carries the freshly minted token in the client's own format (terminal
 * command vs JSON config), that the Claude Code step says to run it in a
 * terminal, and that browser-only assistants are stated as unsupported
 * instead of left for the operator to hunt for.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

test("a minted token comes with setup for every client", async ({ page }) => {
  await page.goto("/settings/mcp");
  await page.getByLabel("Name").fill(`e2e-clients-${Date.now()}`);
  await page.getByLabel("Scope").selectOption("admin");
  await page.getByRole("button", { name: "Create token" }).click();

  const setup = page.getByTestId("mcp-client-setup");
  await expect(setup).toBeVisible();
  const token = (await page.locator("pre code").first().innerText()).trim();
  expect(token.length).toBeGreaterThan(10);

  await expect(setup).toContainText("in the terminal, not inside Claude Code");
  const claude = page.getByTestId("mcp-setup-claude-code");
  await expect(claude).toContainText("claude mcp add caelo-admin");
  await expect(claude).toContainText(token);

  const tabs: Array<[string, string, string]> = [
    ["Claude Desktop", "mcp-setup-claude-desktop", '"mcpServers"'],
    ["Codex CLI", "mcp-setup-codex", "codex mcp add caelo-admin"],
    ["Cursor", "mcp-setup-cursor", '"mcpServers"'],
    ["VS Code", "mcp-setup-vscode", '"servers"'],
    ["Gemini CLI", "mcp-setup-gemini", '"mcpServers"'],
  ];
  for (const [tab, testid, marker] of tabs) {
    await setup.getByRole("tab", { name: tab }).click();
    const snippet = page.getByTestId(testid);
    await expect(snippet).toContainText(marker);
    await expect(snippet).toContainText(token);
  }

  await expect(setup).toContainText("ChatGPT and claude.ai in the browser can't connect yet");
});
