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
 * client-side navigation (marker kept) from a full page load (marker gone),
 * and a note in `sessionStorage`, which outlives the document, records any
 * page data the old client still fetched for the target.
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

/**
 * Waits until SvelteKit's client router runs in this document: it sets
 * `history.scrollRestoration` to "manual" (a new history entry starts as
 * "auto") right before it starts listening for link clicks. Visible
 * server-rendered markup and the `load` event both come earlier.
 */
const routerStarted = (page: Page) =>
  expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe("manual");

const OLD_CLIENT_DATA = "e2e:1656-old-client-page-data";

/** Notes in sessionStorage every page-data request this document's client makes. */
const notePageDataRequests = (page: Page) =>
  page.evaluate((key) => {
    const fetchBefore = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname.endsWith("/__data.json")) sessionStorage.setItem(key, url.pathname);
      return fetchBefore(input, init);
    }) as typeof fetch;
  }, OLD_CLIENT_DATA);
const oldClientPageData = (page: Page) =>
  page.evaluate((key) => sessionStorage.getItem(key), OLD_CLIENT_DATA);

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
  await routerStarted(page);
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });

  // Same release: the navigation stays in the document.
  await markDocument(page);
  await sidebar.getByRole("link", { name: /^Pages$/ }).click();
  await expect(page).toHaveURL("/content/pages");
  expect(await sameDocument(page)).toBe(true);

  // A newer release is deployed: the next navigation is a full page load,
  // and the old client never fetches (and renders) the target's data.
  await deployNewerRelease(page);
  await notePageDataRequests(page);
  await sidebar.getByRole("link", { name: /^Dashboard$/ }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("dashboard-live-edit")).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
  expect(await oldClientPageData(page)).toBeNull();

  // Back, after the next check found a newer release again: the page
  // reloads at the address the history step went to. The new document
  // takes client-side navigations only once its router runs.
  await page.unroute("**/_app/version.json");
  await routerStarted(page);
  await markDocument(page);
  await sidebar.getByRole("link", { name: /^Pages$/ }).click();
  await expect(page).toHaveURL("/content/pages");
  expect(await sameDocument(page)).toBe(true);
  await deployNewerRelease(page);
  await page.goBack();
  await expect(page).toHaveURL("/");
  await expect.poll(() => sameDocument(page).catch(() => null), { timeout: 10_000 }).toBe(false);
  await expect(page.getByTestId("dashboard-live-edit")).toBeVisible();

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
