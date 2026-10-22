// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — the AI creates a user, the operator approves in the chat, and
 * the new user's one-time password goes to the operator only:
 *
 *   - the AI's turn ends without the password (the model never had it);
 *   - the "One-time credentials" box in the chat shows it once, on click;
 *   - the password signs the new user in;
 *   - after a reload the box is gone — nothing secret was stored.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  attachTestProviderHeader,
  clearLoginRateBucket,
  clearTestProvider,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  registerTestProvider,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

const BASE = `http://localhost:${process.env.CAELO_E2E_PORT ?? "4173"}`;
const PROVIDER = `credential-handoff-${Date.now()}`;
const OWNER_EMAIL = "credential-handoff-e2e-owner@example.com";

test.afterAll(async () => {
  await clearTestProvider(BASE, PROVIDER);
});

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

test("a user the AI created gets a password only the approving operator sees", async ({
  browser,
  context,
  page,
}) => {
  const newEmail = `credential-handoff-${Date.now()}@example.com`;
  await registerTestProvider(BASE, PROVIDER, [
    [
      { kind: "text-delta", text: "I'll invite them." },
      {
        kind: "tool-call",
        id: `tc-invite-${Date.now()}`,
        name: "propose_create_user",
        arguments: { email: newEmail, displayName: "Handoff Invitee", roleNames: ["editor"] },
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "tool_use" },
    ],
    [
      { kind: "text-delta", text: "Invited." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ],
  ]);
  await attachTestProviderHeader(context, PROVIDER);
  ensureIsolatedOwner(OWNER_EMAIL);
  await login(page, OWNER_EMAIL, ISOLATED_OWNER_PASSWORD);
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  await page.goto("/content/chat");
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const composer = page.getByTestId("chat-composer");
  await composer.fill("Invite our new editor.");
  await composer.press("Enter");

  const card = page.getByTestId("chat-approval-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("chat-approval-approve").click();
  await expect(page.getByText("Invited.")).toBeVisible({ timeout: 20_000 });

  const box = page.getByTestId("credential-handoffs");
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toContainText(newEmail);
  await box.getByTestId("credential-handoff-reveal").click();
  const secret = page.getByTestId("credential-handoff-secret");
  await expect(secret).toBeVisible({ timeout: 10_000 });
  const password = (await secret.textContent())?.trim() ?? "";
  expect(password.length).toBeGreaterThanOrEqual(16);

  // What the model and the transcript received is scanned in
  // credential-free-ai-results.integration.test.ts; here: the password works
  // for the new user.
  const invitee = await browser.newContext();
  const inviteePage = await invitee.newPage();
  await login(inviteePage, newEmail, password);
  await expect(inviteePage).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await invitee.close();

  // Shown once: after a reload there is nothing left to reveal.
  await page.reload();
  await expect(page.getByTestId("credential-handoff")).toHaveCount(0);
});
