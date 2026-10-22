// SPDX-License-Identifier: MPL-2.0

/**
 * #914 — Settings → Google sign-in, the Owner's guided setup of the
 * install's one Google OAuth client, without Google: the suite runs the
 * admin with CAELO_E2E_GOOGLE_IAP=1 (a gcp-firebase install whose Google
 * organisation is example.com; every Google call fails). Pins that the page
 * is reachable from Settings, hands the Owner the consent-screen settings
 * (External + In production), the console link and BOTH redirect URIs —
 * IAP's appearing once a client ID is typed — validates the pasted client
 * before anything is stored, keeps the secret out of errors, and reports a
 * failed store with what happened.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const GATEWAY = "https://caelo-production-gateway-e2e-ew.a.run.app";
const CLIENT = "123456789012-abc123def456.apps.googleusercontent.com";

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

test("Settings lists Google sign-in under People & access", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "Google sign-in" }).first().click();
  await expect(page).toHaveURL("/settings/google-sign-in");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("step 1 points at the consent screen: External, In production", async ({ page }) => {
  await page.goto("/settings/google-sign-in");
  await expect(page.getByTestId("google-sign-in-audience-link")).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/auth/audience?project=caelo-e2e",
  );
  const steps = page.getByTestId("google-sign-in-consent-steps");
  await expect(steps).toContainText("User type: External");
  await expect(steps).toContainText("Publishing status: In production");
  await expect(steps).toContainText("7 days");
});

test("step 2 shows the console link, the broker redirect URI, and IAP's once a client ID is typed", async ({
  page,
}) => {
  await page.goto("/settings/google-sign-in");
  const consoleLink = page.getByTestId("google-sign-in-console-link");
  await expect(consoleLink).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/auth/clients/create?project=caelo-e2e",
  );
  await expect(consoleLink).toHaveAttribute("target", "_blank");
  // Google's "AI-powered agent" (agentic) flag only governs calling Google
  // Workspace MCP servers, and is permanent from 12 November 2026.
  const agentic = page.getByTestId("google-sign-in-agentic-hint");
  await expect(agentic).toContainText("Use this client for an AI-powered agent");
  await expect(agentic).toContainText("Google Workspace's MCP servers");
  await expect(agentic).toContainText("only to sign people in");
  await expect(agentic).toContainText("12 November 2026");
  await expect(page.getByTestId("google-sign-in-broker-redirect-uri")).toHaveText(
    `${GATEWAY}/api/mcp/oauth/google-callback`,
  );
  await expect(page.getByTestId("google-sign-in-iap-redirect-pending")).toBeVisible();
  await expect(page.getByTestId("google-sign-in-iap-redirect-uri")).toHaveCount(0);

  await page.getByTestId("google-sign-in-form").getByLabel("Client ID").fill(CLIENT);
  await expect(page.getByTestId("google-sign-in-iap-redirect-uri")).toHaveText(
    `https://iap.googleapis.com/v1/oauth/clientIds/${CLIENT}:handleRedirect`,
  );
});

test("step 3 refuses a malformed client before storing anything", async ({ page }) => {
  await page.goto("/settings/google-sign-in");
  const form = page.getByTestId("google-sign-in-form");
  await form.getByLabel("Client ID").fill("my-client");
  await form.getByLabel("Client secret").fill("short");
  await form.getByRole("button", { name: "Save and check" }).click();

  await expect(page.getByTestId("google-sign-in-error-clientId")).toContainText(
    "apps.googleusercontent.com",
  );
  await expect(page.getByTestId("google-sign-in-error-clientSecret")).toContainText("GOCSPX-");
  // The ID stays for fixing in place; the secret input stays masked.
  await expect(form.getByLabel("Client ID")).toHaveValue("my-client");
  await expect(form.getByLabel("Client secret")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("step 3 with a valid client reports a failed store loudly and stays off", async ({ page }) => {
  await page.goto("/settings/google-sign-in");
  const form = page.getByTestId("google-sign-in-form");
  await form.getByLabel("Client ID").fill(CLIENT);
  await form.getByLabel("Client secret").fill("GOCSPX-e2e-not-a-real-secret");
  await form.getByRole("button", { name: "Save and check" }).click();

  const error = page.getByTestId("google-sign-in-error");
  await expect(error).toContainText("could not be stored in Secret Manager");
  await expect(error).toContainText("Nothing was changed");
  await expect(error).not.toContainText("GOCSPX-e2e-not-a-real-secret");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});
