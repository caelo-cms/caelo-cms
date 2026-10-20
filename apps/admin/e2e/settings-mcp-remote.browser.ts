// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — Settings → MCP → Remote, the Owner's guided setup, without Google:
 * the suite runs the admin with CAELO_E2E_REMOTE_MCP=1 (a gcp-firebase
 * install's remote-MCP env; every Google call fails). Pins that the page
 * hands the Owner the exact console link and redirect URI, validates the
 * pasted client before anything is stored, keeps the secret out of errors, reports
 * a failed store with what happened, and gives every client its URL form.
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

test("the MCP page leads to the remote setup", async ({ page }) => {
  await page.goto("/settings/mcp");
  await page
    .getByTestId("mcp-remote-entry")
    .getByRole("link", { name: "Set up remote MCP" })
    .click();
  await expect(page).toHaveURL("/settings/mcp/remote");
  await expect(page.getByTestId("remote-mcp-status")).toHaveText("Off");
});

test("step 1 opens the project's console page and shows the exact redirect URI", async ({
  page,
}) => {
  await page.goto("/settings/mcp/remote");
  const consoleLink = page.getByTestId("remote-mcp-console-link");
  await expect(consoleLink).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/auth/clients/create?project=caelo-e2e",
  );
  await expect(consoleLink).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("remote-mcp-redirect-uri")).toHaveText(
    `${GATEWAY}/api/mcp/oauth/google-callback`,
  );
  await expect(page.getByText("Web application")).toBeVisible();
  await expect(page.getByText("Use this client for an AI-powered agent")).toBeVisible();
});

test("step 2 refuses a malformed client before storing anything", async ({ page }) => {
  await page.goto("/settings/mcp/remote");
  const form = page.getByTestId("remote-mcp-form");
  await form.getByLabel("Client ID").fill("my-client");
  await form.getByLabel("Client secret").fill("short");
  await form.getByRole("button", { name: "Save and check" }).click();

  await expect(page.getByTestId("remote-mcp-error-clientId")).toContainText(
    "apps.googleusercontent.com",
  );
  await expect(page.getByTestId("remote-mcp-error-clientSecret")).toContainText("GOCSPX-");
  // The ID stays for fixing in place; the secret input stays masked.
  await expect(form.getByLabel("Client ID")).toHaveValue("my-client");
  await expect(form.getByLabel("Client secret")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("remote-mcp-status")).toHaveText("Off");
});

test("step 2 with a valid client reports a failed store loudly and stays off", async ({ page }) => {
  await page.goto("/settings/mcp/remote");
  const form = page.getByTestId("remote-mcp-form");
  await form.getByLabel("Client ID").fill("123456789012-abc123def456.apps.googleusercontent.com");
  await form.getByLabel("Client secret").fill("GOCSPX-e2e-not-a-real-secret");
  await form.getByRole("button", { name: "Save and check" }).click();

  const error = page.getByTestId("remote-mcp-error");
  await expect(error).toContainText("could not be stored in Secret Manager");
  await expect(error).toContainText("Nothing was changed");
  await expect(error).not.toContainText("GOCSPX-e2e-not-a-real-secret");
  await expect(page.getByTestId("remote-mcp-status")).toHaveText("Off");
});

test("step 3 gives every client the MCP URL in its own form", async ({ page }) => {
  await page.goto("/settings/mcp/remote");
  const setup = page.getByTestId("remote-mcp-client-setup");
  await expect(page.getByTestId("remote-mcp-url")).toHaveText(`${GATEWAY}/api/mcp/chat`);

  await setup.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByTestId("remote-mcp-setup-claude-code")).toHaveText(
    `claude mcp add --transport http caelo ${GATEWAY}/api/mcp/chat`,
  );

  await setup.getByLabel("What should the AI tool get?").selectOption("admin");
  await expect(page.getByTestId("remote-mcp-url")).toHaveText(`${GATEWAY}/api/mcp/admin`);
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
