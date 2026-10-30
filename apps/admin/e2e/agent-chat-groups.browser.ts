// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — one chat per external agent, grouped per client.
 *
 * Three Power-MCP agents of one client (one token) each open their work
 * session. The chat list shows the operator's own chats apart from the
 * agents', and the agents' three chats under one client group; Live Edit
 * keeps opening the operator's own chat, never an agent's.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  mintAdminMcpToken,
} from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

// This spec's own Owner, so a parallel spec's chats never land in its list.
const OWNER_EMAIL = "agent-groups-e2e-owner@example.com";
const CLIENT = `agent-groups-e2e ${Date.now().toString(36)}`;

async function login(page: Page): Promise<void> {
  ensureIsolatedOwner(OWNER_EMAIL);
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

test("agent chats are listed per client, apart from the operator's own chats", async ({
  page,
  request,
}) => {
  const token = mintAdminMcpToken(ensureIsolatedOwner(OWNER_EMAIL), CLIENT);
  const titles = [1, 2, 3].map((i) => `agent-groups-e2e agent ${i} ${Date.now().toString(36)}`);
  const ids: string[] = [];
  for (const title of titles) {
    const res = await request.post("/api/mcp/session", {
      headers: { "x-caelo-mcp-token": token },
      data: { title },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { chatSessionId: string; resumed: boolean };
    // Every agent gets a session of its own, never a resumed one.
    expect(body.resumed).toBe(false);
    ids.push(body.chatSessionId);
  }
  expect(new Set(ids).size).toBe(3);

  // Live Edit opens the operator's own chat, not the newest agent chat.
  await login(page);
  await expect(page.getByTestId("chat-picker-trigger")).not.toContainText("agent-groups-e2e");

  await page.goto("/content/chat");
  const group = page.getByTestId("agent-chat-group").filter({ hasText: CLIENT });
  await expect(group).toBeVisible({ timeout: 10_000 });
  await expect(group.getByText(`Agents · ${CLIENT}`)).toBeVisible();
  await expect(group.getByText("3 agent chats")).toBeVisible();
  for (const title of titles) await expect(group.getByRole("link", { name: title })).toBeVisible();

  // The Live Edit chat picker groups them the same way.
  await page.goto("/edit");
  await page.getByTestId("chat-picker-trigger").click();
  const pickerGroup = page.getByTestId("agent-chat-group").filter({ hasText: CLIENT });
  await expect(pickerGroup).toBeVisible();
  for (const title of titles)
    await expect(page.getByRole("menuitem", { name: title })).toBeVisible();
});
