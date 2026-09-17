// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/** No AI calls, no plugins, no external font provider required. */
test("core font import loads the actual face and reports missing glyphs", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(edit|welcome\/ai)/);
  await page.goto("/design/fonts");
  await page.getByText("Upload a licensed font", { exact: true }).click();
  const bytes = Buffer.from(
    readFileSync(
      new URL(
        "../../../packages/font-service/src/fixtures/NotoSans-Regular.base64.txt",
        import.meta.url,
      ),
      "utf8",
    ).trim(),
    "base64",
  );
  await page
    .getByLabel("Font file (TTF, OTF, WOFF, WOFF2; up to 8 MiB)")
    .setInputFiles({ name: "NotoSans.woff", mimeType: "font/woff", buffer: bytes });
  await page.getByLabel("License name", { exact: true }).fill("OFL-1.1");
  await page
    .getByLabel("License text", { exact: true })
    .fill(
      readFileSync(
        new URL("../../../packages/font-service/src/fixtures/OFL.txt", import.meta.url),
        "utf8",
      ),
    );
  await page.getByLabel("My license permits embedding on websites").check();
  await page.getByLabel("My license permits embedding in documents").check();
  await page.getByRole("button", { name: "Import font file", exact: true }).click();
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Noto Sans · Regular", exact: true }) })
    .first();
  const specimen = card.locator("[data-font-specimen]");
  await expect(specimen).toBeVisible();
  const face = await specimen.evaluate((el) => {
    const family = getComputedStyle(el).fontFamily;
    return { family, loaded: document.fonts.check(`32px ${family}`) };
  });
  expect(face.family).toMatch(/^CaeloFont_[a-f0-9]{64}$/);
  expect(face.loaded).toBe(true);
  const ref = await card.locator('input[name="id"]').inputValue();
  const sha256 = await card.locator('input[name="sha256"]').inputValue();
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(
    new URL(`/design/fonts/${ref}?sha256=${sha256}`, page.url()).href,
    { maxRedirects: 0 },
  );
  expect([302, 303, 401, 403]).toContain(denied.status());
  await anonymous.close();
  await page.getByLabel("Preview text", { exact: false }).fill("🦄");
  await expect(card.getByRole("status")).toContainText("FontMissingCharacters");
  await expect(specimen).toHaveCount(0);
});
