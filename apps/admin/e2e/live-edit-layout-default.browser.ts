// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — verifies that the seeded `home` page picks up the
 * `site-default` layout's chrome (header + content + footer slots) by
 * default. Test asserts the rendered preview includes the layout's
 * structural HTML (header tag, footer tag, content slot wrapped in
 * <main class="caelo-layout-main">).
 *
 * Together with `live-edit-layout-isolation.browser.ts` (which proves
 * `bare`-layout pages don't get site-default chrome), these two cover
 * the "every page has a default layout" + "multi-layout works" core
 * scenarios from the P6.7.6 plan.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor } from "./helpers.js";

test.beforeAll(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test("seeded home page renders inside site-default layout (header + content + footer)", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });

  await page.goto("/edit");

  // The /edit iframe loads /edit/preview-by-path/<locale>/<path>
  // which streams composed HTML. We fetch the same URL directly to
  // assert structure without depending on iframe ready timing.
  const previewUrl = "/edit/preview-by-path/en/home";
  const res = await page.request.get(previewUrl);
  expect(res.status(), "preview endpoint should serve 200").toBe(200);
  const html = await res.text();

  expect(html, "layout header chrome present").toContain('class="caelo-layout-header"');
  expect(html, "layout main wraps the content").toContain('class="caelo-layout-main"');
  expect(html, "layout footer chrome present").toContain('class="caelo-layout-footer"');
  // The page's modules survive the wrap — every rendered module gets a
  // data-caelo-module-id attribute, so its presence proves the inner
  // template render flowed into the layout's content slot.
  expect(html, "page module content rendered inside the layout").toContain("data-caelo-module-id=");
});
