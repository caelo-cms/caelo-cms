// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/**
 * §4 invariant: provider brand never surfaces in the editor chat UI —
 * editors see "AI", brand only on /security/ai. This spec scans the
 * rendered chat HTML for any provider-brand string and asserts the
 * security panel actually does carry the brand (so the test is
 * meaningful, not vacuous).
 */

test("chat surface contains no provider-brand strings; /security/ai does", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  // Chat index — should be brand-free.
  await page.goto("/content/chat");
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible();
  const chatIndexHtml = (await page.content()).toLowerCase();
  expect(chatIndexHtml).not.toContain("anthropic");
  expect(chatIndexHtml).not.toContain("claude");

  // Create a new chat and inspect the active chat surface.
  await page.getByRole("button", { name: /\+ new chat/i }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[0-9a-f-]+$/, { timeout: 15_000 });
  const activeHtml = (await page.content()).toLowerCase();
  expect(activeHtml).not.toContain("anthropic");
  expect(activeHtml).not.toContain("claude");

  // Security panel SHOULD mention the brand — proves the test is meaningful.
  await page.goto("/security/ai");
  const securityHtml = (await page.content()).toLowerCase();
  expect(securityHtml).toContain("anthropic");
});
