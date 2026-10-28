// SPDX-License-Identifier: MPL-2.0

/**
 * The admin on a phone (operator report, 2026-10-26: "no menu in the
 * admin, the chat is gone after tapping the four-arrows control"). Each
 * test encodes one defect of that report:
 *   - below `md` the sidebar is hidden, so the main navigation must open
 *     from the header's menu button;
 *   - no admin screen scrolls sideways at phone width;
 *   - the live-edit chat is the full-width surface under the toolbar on a
 *     phone, can be collapsed to show the page and always comes back;
 *   - a floating chat (the four-arrows "Float" control) stays on screen
 *     when the window is narrower than where it was placed, and becomes
 *     the phone surface below `md` instead of vanishing off the edge.
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket, resetOverlayLayoutFor } from "./helpers.js";

const PHONE = { width: 390, height: 844 };

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth, `${where} scrolls sideways`).toBeLessThanOrEqual(innerWidth);
}

async function overlayBox(page: Page) {
  const box = await page.getByTestId("live-edit-overlay").boundingBox();
  if (!box) throw new Error("the live-edit chat overlay is not rendered");
  return box;
}

test.beforeEach(() => {
  clearLoginRateBucket();
  resetOverlayLayoutFor("dev-owner@example.com");
});

test.describe("phone width", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the main navigation opens from the header menu and closes after navigating", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/content/pages");
    // The desktop sidebar is hidden on a phone …
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeHidden();
    // … so the header's menu button is the way in.
    await page.getByRole("button", { name: "Open menu" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Log out" })).toBeVisible();
    await sheet.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("no admin screen scrolls sideways", async ({ page }) => {
    await login(page);
    for (const path of ["/", "/content/pages", "/content/modules", "/content/lists", "/settings"]) {
      await page.goto(path);
      await expectNoSidewaysScroll(page, path);
    }
    await page.goto("/edit");
    await expect(page.getByTestId("live-edit-overlay")).toBeVisible();
    await expectNoSidewaysScroll(page, "/edit");
    const toolbar = page.getByTestId("edit-toolbar");
    const overflow = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the live-edit toolbar overflows").toBeLessThanOrEqual(0);
  });

  test("the live-edit chat fills the phone, collapses to the page and comes back", async ({
    page,
  }) => {
    await login(page);
    const overlay = page.getByTestId("live-edit-overlay");
    await expect(overlay).toHaveAttribute("data-compact", "true");
    const box = await overlayBox(page);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    // Desktop gestures are not offered on a phone.
    await expect(page.getByRole("button", { name: "Float" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pin to right" })).toHaveCount(0);

    await page.getByRole("button", { name: "Collapse" }).click();
    const reopen = page.getByTestId("overlay-collapsed-button");
    await expect(reopen).toBeInViewport();
    await reopen.click();
    await expect(overlay).toBeVisible();
    await expect(page.getByPlaceholder(/^Tell the AI what to change/)).toBeInViewport();
    // The composer's actions wrap instead of running past the panel's edge.
    for (const testId of ["chat-extended-thinking-toggle"]) {
      const b = await page.getByTestId(testId).boundingBox();
      expect(b && b.x + b.width, `${testId} is cut off`).toBeLessThanOrEqual(PHONE.width);
    }
    await expect(page.getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
  });
});

test("a floating chat stays on screen when the window narrows, and is the phone surface below md", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "Float" }).click();
  // Drag the floating chat by its title bar towards the right edge.
  const bar = page.getByLabel("Live-edit overlay controls");
  const start = await bar.boundingBox();
  if (!start) throw new Error("no title bar");
  await page.mouse.move(start.x + 20, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 900, start.y + 200, { steps: 10 });
  await page.mouse.up();
  const placed = await overlayBox(page);
  expect(placed.x).toBeGreaterThan(800);

  // A narrower window: the box is pulled back on screen, not cut off.
  await page.setViewportSize({ width: 900, height: 700 });
  const narrowed = await overlayBox(page);
  expect(narrowed.x).toBeGreaterThanOrEqual(0);
  expect(narrowed.x + narrowed.width).toBeLessThanOrEqual(900);
  expect(narrowed.y + narrowed.height).toBeLessThanOrEqual(700);
  await expect(page.getByRole("button", { name: "Collapse" })).toBeInViewport();
  // A drag from there moves the box from where it is drawn (PR #1166
  // review): 100 px left lands 100 px left, no jump to the stored x.
  const handle = await page.getByLabel("Live-edit overlay controls").boundingBox();
  if (!handle) throw new Error("no title bar");
  await page.mouse.move(handle.x + 20, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const dragged = await overlayBox(page);
  expect(Math.round(narrowed.x - dragged.x)).toBe(100);

  // A phone: the full-width surface, whatever the stored float position.
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId("live-edit-overlay")).toHaveAttribute("data-compact", "true");
  const phone = await overlayBox(page);
  expect(phone.x).toBe(0);
  expect(phone.width).toBe(PHONE.width);
});
