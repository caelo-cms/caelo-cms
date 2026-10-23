// SPDX-License-Identifier: MPL-2.0

/**
 * #914 / #967 — Settings → Google sign-in, the Owner's guided setup of the
 * install's one Google OAuth client, without Google Cloud: the suite runs
 * the admin with CAELO_E2E_GOOGLE_IAP=1 (a gcp-firebase install whose
 * Google organisation is example.com). Google's OAuth endpoints answer with
 * the responses recorded live for #967 (lib/server/google-iap.ts
 * E2E_GOOGLE_OAUTH: a client ID containing `noiap` lacks redirect URI 2,
 * `GOCSPX-e2e-wrong-secret` is wrong); Secret Manager fails, as on an
 * install without the version-adder grant.
 *
 * Pins: the page says when the client is needed at all; one console pass —
 * BOTH redirect URIs appear together as soon as a client ID is pasted; the
 * preflight refuses a client missing redirect URI 2 or with a wrong secret
 * before anything is stored; a passing client still needs the explicit
 * "Every user signs in to the admin once more" confirmation before Caelo
 * stores it.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const GATEWAY = "https://caelo-production-gateway-e2e-ew.a.run.app";
const CLIENT = "123456789012-abc123def456.apps.googleusercontent.com";
const NO_IAP_URI = "123456789012-noiap123.apps.googleusercontent.com";
const SECRET = "GOCSPX-e2e-not-a-real-secret";

test.beforeEach(async ({ page }) => {
  clearLoginRateBucket();
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
});

async function fillClient(
  page: Page,
  opts: { clientId: string; secret: string; consent?: boolean },
): Promise<void> {
  const form = page.getByTestId("google-sign-in-form");
  if (opts.consent ?? true) await form.getByTestId("google-sign-in-consent-confirm").click();
  await form.getByLabel("Client ID").fill(opts.clientId);
  await form.getByLabel("Client secret").fill(opts.secret);
}

test("Settings lists Google sign-in under People & access, saying when it is needed", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: "Google sign-in" }).first().click();
  await expect(page).toHaveURL("/settings/google-sign-in");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
  const when = page.getByTestId("google-sign-in-when-needed");
  await expect(when).toContainText("remote MCP");
  await expect(when).toContainText("outside your organisation");
});

test("step 1 points at the consent screen and asks to confirm it, since Google cannot be asked", async ({
  page,
}) => {
  await page.goto("/settings/google-sign-in");
  await expect(page.getByTestId("google-sign-in-audience-link")).toHaveAttribute(
    "href",
    "https://console.cloud.google.com/auth/audience?project=caelo-e2e",
  );
  const steps = page.getByTestId("google-sign-in-consent-steps");
  await expect(steps).toContainText("User type: External");
  await expect(steps).toContainText("Publishing status: In production");
  await expect(steps).toContainText("7 days");
  await expect(page.getByTestId("google-sign-in-consent-confirm")).toContainText(
    "Google offers no way for Caelo to check this",
  );
});

test("#967: both redirect URIs appear together right after the client ID is pasted", async ({
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

  await expect(page.getByTestId("google-sign-in-redirect-uris-pending")).toBeVisible();
  await expect(page.getByTestId("google-sign-in-broker-redirect-uri")).toHaveCount(0);
  await expect(page.getByTestId("google-sign-in-iap-redirect-uri")).toHaveCount(0);

  await page.getByTestId("google-sign-in-form").getByLabel("Client ID").fill(CLIENT);
  await expect(page.getByTestId("google-sign-in-broker-redirect-uri")).toHaveText(
    `${GATEWAY}/api/mcp/oauth/google-callback`,
  );
  await expect(page.getByTestId("google-sign-in-iap-redirect-uri")).toHaveText(
    `https://iap.googleapis.com/v1/oauth/clientIds/${CLIENT}:handleRedirect`,
  );
  await expect(page.getByTestId("google-sign-in-client-console-link")).toHaveAttribute(
    "href",
    `https://console.cloud.google.com/auth/clients/${encodeURIComponent(CLIENT)}?project=caelo-e2e`,
  );
  // Each URI has its own copy button.
  await expect(
    page.getByRole("button", { name: "Copy Redirect URI 1 (remote MCP)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy Redirect URI 2 (Google IAP)" }),
  ).toBeVisible();
});

test("refuses a malformed client before asking Google or storing anything", async ({ page }) => {
  await page.goto("/settings/google-sign-in");
  await fillClient(page, { clientId: "my-client", secret: "short" });
  await page.getByRole("button", { name: "Check the client" }).click();

  await expect(page.getByTestId("google-sign-in-error-clientId")).toContainText(
    "apps.googleusercontent.com",
  );
  await expect(page.getByTestId("google-sign-in-error-clientSecret")).toContainText("GOCSPX-");
  const form = page.getByTestId("google-sign-in-form");
  await expect(form.getByLabel("Client ID")).toHaveValue("my-client");
  await expect(form.getByLabel("Client secret")).toHaveAttribute("type", "password");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("#967: a client missing redirect URI 2 is refused before anything changes, naming the fix", async ({
  page,
}) => {
  await page.goto("/settings/google-sign-in");
  await fillClient(page, { clientId: NO_IAP_URI, secret: SECRET });
  await page.getByRole("button", { name: "Check the client" }).click();

  const iap = page.getByTestId("google-sign-in-check-redirect-uri-iap");
  await expect(iap).toContainText("redirect_uri_mismatch");
  await expect(iap).toContainText("IAP error code 9");
  await expect(iap).toContainText(
    `https://iap.googleapis.com/v1/oauth/clientIds/${NO_IAP_URI}:handleRedirect`,
  );
  await expect(page.getByTestId("google-sign-in-check-redirect-uri-broker")).toContainText(
    `${GATEWAY}/api/mcp/oauth/google-callback`,
  );
  await expect(page.getByTestId("google-sign-in-error")).toContainText(
    "Nothing was stored and Google IAP was not touched.",
  );
  await expect(page.getByTestId("google-sign-in-relogin-confirm")).toHaveCount(0);
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("#967: a wrong secret is refused before anything changes, and never shown", async ({
  page,
}) => {
  await page.goto("/settings/google-sign-in");
  await fillClient(page, { clientId: CLIENT, secret: "GOCSPX-e2e-wrong-secret" });
  await page.getByRole("button", { name: "Check the client" }).click();

  await expect(page.getByTestId("google-sign-in-check-client-secret")).toContainText(
    "refused the client secret",
  );
  await expect(page.getByTestId("google-sign-in-relogin-confirm")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("GOCSPX-e2e-wrong-secret");
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});

test("#967: a passing client needs the re-login confirmation; only then does Caelo try to store it", async ({
  page,
}) => {
  await page.goto("/settings/google-sign-in");
  await fillClient(page, { clientId: CLIENT, secret: SECRET });
  await page.getByRole("button", { name: "Check the client" }).click();

  for (const id of ["redirect-uri-broker", "redirect-uri-iap", "client-secret", "consent-screen"]) {
    await expect(page.getByTestId(`google-sign-in-check-${id}`).getByLabel("ok")).toBeVisible();
  }
  // Checked, not switched: nothing stored, the confirmation is the next step.
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
  const confirm = page.getByTestId("google-sign-in-relogin-confirm");
  await expect(confirm).toContainText("Every user signs in to the admin once more.");

  // Editing the client after the check withdraws the confirmation step.
  await page.getByTestId("google-sign-in-form").getByLabel("Client secret").fill(`${SECRET}x`);
  await expect(confirm).toHaveCount(0);
  await page.getByTestId("google-sign-in-form").getByLabel("Client secret").fill(SECRET);
  await page.getByRole("button", { name: "Check the client" }).click();
  await expect(confirm).toBeVisible();

  // Confirming stores the client: here Secret Manager refuses, so the
  // failure is loud and nothing changes.
  await page.getByTestId("google-sign-in-switch").click();
  const error = page.getByTestId("google-sign-in-error");
  await expect(error).toContainText("could not be stored in Secret Manager");
  await expect(error).toContainText("Nothing was changed");
  await expect(error).not.toContainText(SECRET);
  await expect(page.getByTestId("google-sign-in-status")).toHaveText("Off");
});
