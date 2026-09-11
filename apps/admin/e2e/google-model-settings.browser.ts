// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "@playwright/test";

test("Owner saves separate Google chat and image models without re-entering the key", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/);
  await page.goto("/security/ai");
  const form = page
    .locator('form[action="?/set"]')
    .filter({ has: page.locator('input[name="name"][value="google"]') });
  const model = form.locator('[name="model"]');
  const image = form.getByLabel("Image model", { exact: true });
  const previousModel = await model.inputValue();
  const previousImage = await image.inputValue();
  try {
    await model.selectOption("gemini-3.8-flash");
    await image.fill("gemini-3.1-flash-image");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved google.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(model).toHaveValue("gemini-3.8-flash");
    await expect(image).toHaveValue("gemini-3.1-flash-image");
    await expect(form.locator('[name="apiKey"]')).toHaveValue("");
    await image.fill("");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved google.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(image).toHaveValue("");
  } finally {
    await model.selectOption(previousModel);
    await image.fill(previousImage);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved google.", { exact: true })).toBeVisible();
  }
});
