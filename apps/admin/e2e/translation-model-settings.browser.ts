// SPDX-License-Identifier: MPL-2.0

/**
 * #593 — /security/ai "Translation model": defaults to "Same as chat
 * model", the Owner picks a catalogue model, it persists across a reload,
 * and choosing "Same as chat model" again stores NULL. The chat-model form
 * is untouched by it.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner sets and clears the translation model", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);
  await page.goto("/security/ai");

  const providerForm = page
    .locator('form[action="?/set"]')
    .filter({ has: page.locator('input[name="name"][value="google"]') });
  const translationForm = page
    .locator('form[action="?/set_translation_model"]')
    .filter({ has: page.locator('input[name="name"][value="google"]') });
  // The setting lives on a configured provider row; save the Google row
  // once (no key needed) if this database has never had one.
  if ((await translationForm.count()) === 0) {
    await providerForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved google.", { exact: true })).toBeVisible();
    await page.reload();
  }

  const select = translationForm.getByLabel("Translation model", { exact: true });
  const chatModel = providerForm.locator('[name="model"]');
  const chatBefore = await chatModel.inputValue();
  const previous = await select.inputValue();
  const options = await select
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(options[0]).toBe("");
  const pick = options.find((v) => v !== "" && v !== previous) as string;

  try {
    await select.selectOption(pick);
    await translationForm.getByRole("button", { name: "Save translation model" }).click();
    await expect(page.getByText("Saved the translation model for google.")).toBeVisible();
    await page.reload();
    await expect(select).toHaveValue(pick);
    await expect(chatModel).toHaveValue(chatBefore);

    await select.selectOption("");
    await translationForm.getByRole("button", { name: "Save translation model" }).click();
    await expect(page.getByText("Saved the translation model for google.")).toBeVisible();
    await page.reload();
    await expect(select).toHaveValue("");
  } finally {
    await select.selectOption(previous);
    await translationForm.getByRole("button", { name: "Save translation model" }).click();
    await expect(page.getByText("Saved the translation model for google.")).toBeVisible();
  }
});
