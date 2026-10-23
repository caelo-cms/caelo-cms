// SPDX-License-Identifier: MPL-2.0

/**
 * P6.5 — pins the AppShell as a first-class surface:
 *   - Live edit as the prominent entry; Dashboard, the Content group and
 *     Settings below it (gated by Owner perms); Account in the footer.
 *   - Clicking a nav item navigates and the URL updates.
 *   - Dark-mode toggle persists across reload.
 *
 * The reviewer-permission cut would belong here too but the existing
 * content-reviewer-readonly.browser.ts already covers that side.
 */

import { expect, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

test("Owner sees AppShell with sidebar nav, can navigate, dark mode persists", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });

  // Login lands in the live editor now (chat-first); the shell under
  // test lives on the admin routes — navigate there explicitly.
  await page.goto("/");

  // Brand mark (#777): the home link keeps its accessible name and shows
  // the Caelatum mark (decorative SVG), not the old letter-"C" placeholder.
  const homeLink = page.getByRole("link", { name: "Caelo CMS — Dashboard" });
  await expect(homeLink).toBeVisible();
  const mark = homeLink.locator('svg[data-caelo-mark="open"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(homeLink).toHaveText("Caelo");

  // #779 — the dashboard names the site's Draft / Preview / Live state;
  // each dot is decorative, the label carries the state.
  const siteState = page.getByTestId("site-state");
  await expect(siteState).toBeVisible();
  for (const [state, label] of [
    ["draft", "Draft"],
    ["preview", "Preview"],
    ["live", "Live"],
  ] as const) {
    const stateMark = siteState.locator(`[data-testid="state-dot"][data-state="${state}"]`);
    await expect(stateMark).toHaveText(label);
    await expect(stateMark.locator('[aria-hidden="true"]')).toHaveCount(1);
  }

  // Live edit is the one prominent entry, at the top of the sidebar. Its
  // accessible name is just "Live edit"; the subtitle is the description.
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  const liveEdit = sidebar.getByRole("link", { name: "Live edit", exact: true });
  await expect(liveEdit).toBeVisible();
  await expect(liveEdit).toHaveAttribute("href", "/edit");
  await expect(liveEdit).toHaveAccessibleDescription("See your site and change it by chat");

  // The dashboard leads into Live edit, not into list views.
  await expect(page.getByTestId("dashboard-live-edit")).toBeVisible();

  // Sidebar: Dashboard, a collapsible Content group, Settings. No ramp-up
  // wizard (setup and migration run in Live edit) and no list views or
  // Ops pages at the top level.
  await expect(sidebar.getByRole("link", { name: /^Dashboard$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Settings$/ })).toBeVisible();
  for (const gone of [/^Ramp up$/, /^Chats$/, /^Deployments$/, /^Quality$/, /^Detected bugs$/]) {
    await expect(sidebar.getByRole("link", { name: gone })).toHaveCount(0);
  }
  const contentToggle = sidebar.getByRole("button", { name: /^Content$/ });
  await expect(contentToggle).toHaveAttribute("aria-expanded", "true");
  for (const name of [/^Pages$/, /^Modules$/, /^Content library$/, /^Media$/, /^Templates$/]) {
    await expect(sidebar.getByRole("link", { name })).toBeVisible();
  }

  // Collapsing the group hides its links and survives a reload.
  await contentToggle.click();
  await expect(contentToggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("link", { name: /^Pages$/ })).toBeHidden();
  await page.reload();
  await expect(contentToggle).toHaveAttribute("aria-expanded", "false");
  await contentToggle.click();
  await expect(contentToggle).toHaveAttribute("aria-expanded", "true");

  // Account sits in the sidebar footer, outside the main list.
  await expect(page.getByRole("link", { name: /^Account$/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Account$/ })).toHaveCount(0);

  // Click Pages → URL updates.
  await sidebar.getByRole("link", { name: /^Pages$/ }).click();
  await expect(page).toHaveURL("/content/pages", { timeout: 5_000 });

  // The old wizard route is gone.
  const rampUp = await page.request.get("/ramp-up", { maxRedirects: 0 });
  expect(rampUp.status()).toBe(404);

  // Toggle dark mode → reload → still dark.
  await page.getByRole("button", { name: /toggle theme/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 2_000 });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 2_000 });

  // Restore light so the next spec starts clean.
  await page.getByRole("button", { name: /toggle theme/i }).click();
});
