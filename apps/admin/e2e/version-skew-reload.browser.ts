// SPDX-License-Identifier: MPL-2.0

/**
 * #1656 — a tab left open across an update runs the previous release's
 * client code; rendering the new release's page data with it crashed into
 * a 500 until the operator reloaded. Once SvelteKit knows a newer release
 * is deployed, a navigation loads the page fully, and an error page reloads
 * once by itself.
 *
 * "A newer release" is simulated by answering `/_app/version.json` with
 * another version; a `focus` event makes SvelteKit check it, as a real tab
 * does when the operator comes back to it. A marker on `window` tells a
 * client-side navigation (marker kept) from a full page load (marker gone).
 */

import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

test.beforeAll(clearLoginRateBucket);

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/edit", { timeout: 15_000 });
}

const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __caeloDocument?: number }).__caeloDocument = 1;
  });
const sameDocument = (page: Page) =>
  page.evaluate(() => (window as unknown as { __caeloDocument?: number }).__caeloDocument === 1);

async function deployNewerRelease(page: Page): Promise<void> {
  await page.route("**/_app/version.json", (route) =>
    route.fulfill({ json: { version: "e2e-newer-release-1656" } }),
  );
  const checked = page.waitForResponse((r) => r.url().endsWith("/_app/version.json"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await checked;
}

test("a navigation after an update loads the page fully, with the new client", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });

  // Same release: the navigation stays in the document.
  await markDocument(page);
  await sidebar.getByRole("link", { name: /^Pages$/ }).click();
  await expect(page).toHaveURL("/content/pages");
  expect(await sameDocument(page)).toBe(true);

  // A newer release is deployed: the next navigation is a full page load.
  await deployNewerRelease(page);
  await sidebar.getByRole("link", { name: /^Dashboard$/ }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("dashboard-live-edit")).toBeVisible();
  expect(await sameDocument(page)).toBe(false);

  await page.unroute("**/_app/version.json");
});

test("an error page in a tab older than the release reloads once, not in a loop", async ({
  page,
}) => {
  await signIn(page);
  const missing = "/no-such-page-1656";
  let loads = 0;
  page.on("request", (r) => {
    if (r.isNavigationRequest() && new URL(r.url()).pathname === missing) loads++;
  });
  // The fake version never matches, as two revisions answering side by
  // side during a rollout would: the guard must stop after one reload.
  await page.route("**/_app/version.json", (route) =>
    route.fulfill({ json: { version: "e2e-newer-release-1656" } }),
  );

  await page.goto(missing);
  await expect.poll(() => loads, { timeout: 10_000 }).toBe(2);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
  // Give a loop the time it would need to show.
  await page.waitForTimeout(3_000);
  expect(loads).toBe(2);

  await page.unroute("**/_app/version.json");
});
