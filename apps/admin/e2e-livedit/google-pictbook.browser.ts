// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

/** Opt-in real-provider acceptance. No provider mocks and no credential seeding. */
test("Google accepts the full tool catalogue and answers the Pictbook entry", async ({ page }) => {
  test.skip(
    process.env.CAELO_LIVE_GOOGLE_PICTBOOK !== "1",
    "Requires locally configured Google credentials and Pictbook",
  );
  test.setTimeout(180_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.CAELO_E2E_EMAIL ?? "dev-owner@example.com");
  await page.getByLabel("Password").fill(process.env.CAELO_E2E_PASSWORD ?? "dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);
  await page.goto("/security/ai");
  const google = page
    .locator('form[action="?/set"]')
    .filter({ has: page.locator('input[name="name"][value="google"]') });
  await expect(google.locator('[name="isActive"]')).toBeChecked();
  await page.goto("/content/chat");
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/chat\/[a-f0-9-]+$/);
  const chatId = new URL(page.url()).pathname.split("/").pop();
  await page.goto(`/edit?chat=${chatId}`);
  const replies = page.locator("li").filter({ has: page.locator("strong", { hasText: /^AI:$/ }) });
  const before = await replies.count();
  await page.getByRole("button", { name: "Bilderbücher mit Pictbook", exact: true }).click();
  await expect
    .poll(
      async () => {
        const error = page.getByTestId("chat-error");
        if (await error.isVisible()) throw new Error(await error.innerText());
        return await replies.count();
      },
      { timeout: 150_000 },
    )
    .toBeGreaterThan(before);
  await expect(page.getByTestId("chat-stop")).toBeHidden({ timeout: 150_000 });
  await expect(page.getByTestId("chat-error")).toHaveCount(0);
  await expect(replies.last()).toContainText(/Buch|Bilderbuch|book|Geschichte|story/i);
  await expect(replies.last()).not.toContainText("Invalid value at");
  await page.screenshot({
    path: process.env.CAELO_E2E_SCREENSHOT ?? "/tmp/pictbook-google-entry-e2e.png",
    fullPage: true,
  });
});
