// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — opening Live Edit shows progress, and parts that stream in after
 * first paint say so when they fail.
 *
 * On searchVIU the editor took over a minute to open (one read ran into the
 * 60 s statement timeout) while the old page stayed on screen without a
 * sign of life, so the operator clicked again; each click started another
 * full load of the same page. Here the editor's data request is held back
 * to make the wait observable, and one streamed part is answered with a
 * failure to check it surfaces instead of disappearing.
 */

import { expect, type Page, type Route, test } from "@playwright/test";
import {
  archiveChat,
  clearLoginRateBucket,
  ensureIsolatedOwner,
  ISOLATED_OWNER_PASSWORD,
  openOwnerChat,
  resetOverlayLayoutFor,
} from "./helpers.js";

/** Own Owner: Live Edit resumes the operator's newest chat (#1081). */
const OWNER_EMAIL = "e2e-open-feedback-owner@example.com";
const ts = Date.now();
const EDIT_DATA = /\/edit\/__data\.json/;

let chatId: string | null = null;

test.beforeAll(() => {
  clearLoginRateBucket();
  ensureIsolatedOwner(OWNER_EMAIL);
  resetOverlayLayoutFor(OWNER_EMAIL);
  // The chat Live Edit resumes, so opening it creates none.
  chatId = openOwnerChat(`e2e-open-feedback-${ts}`, undefined, OWNER_EMAIL);
});

test.afterAll(() => {
  if (chatId) archiveChat(chatId);
});

/** Signs in (which lands in Live Edit) and goes to the dashboard. */
async function signInToDashboard(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(ISOLATED_OWNER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/edit/, { timeout: 15_000 });
  await page.goto("/");
  await expect(page.getByTestId("nav-live-edit").first()).toBeVisible();
}

test("Live edit shows progress at once and a second click starts no second load", async ({
  page,
}) => {
  await signInToDashboard(page);

  let loads = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(EDIT_DATA, async (route) => {
    loads++;
    await held;
    await route.continue();
  });

  const link = page.getByTestId("nav-live-edit").first();
  await link.click();
  await expect(page.getByTestId("navigation-progress")).toBeVisible();
  await expect(link).toHaveAttribute("aria-busy", "true");

  // The operator clicks again while nothing has arrived yet.
  await link.click();
  await expect(page.getByTestId("navigation-progress")).toBeVisible();
  // Long enough for a second request to leave, had the click started one.
  await page.waitForTimeout(500);
  expect(loads).toBe(1);

  release();
  await expect(page).toHaveURL(/\/edit/);
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
  await expect(page.getByTestId("navigation-progress")).toHaveCount(0);
});

/**
 * Answers the streamed `key` of the editor's data with `{ ok: false, error }`.
 * The response is SvelteKit's newline-delimited JSON: the first line holds
 * the page data (devalue-flattened; a streamed promise is `["Promise", i]`,
 * where index `i` holds the promise's id), each later line one settled
 * promise as `{ type: "chunk", id, data }`.
 */
async function failStreamedPart(route: Route, key: string, error: string): Promise<void> {
  const response = await route.fetch();
  const lines = (await response.text()).split("\n").filter((l) => l.length > 0);
  const first = JSON.parse(lines[0] ?? "{}") as {
    nodes?: ({ type: string; data: unknown[] } | null)[];
  };
  let promiseId: number | null = null;
  for (const node of first.nodes ?? []) {
    if (node?.type !== "data") continue;
    const index = (node.data[0] as Record<string, number>)[key];
    const ref = index === undefined ? undefined : node.data[index];
    if (Array.isArray(ref) && ref[0] === "Promise")
      promiseId = node.data[ref[1] as number] as number;
  }
  if (promiseId === null) throw new Error(`no streamed "${key}" in the editor's data`);
  const failed = JSON.stringify({
    type: "chunk",
    id: promiseId,
    data: [{ ok: 1, error: 2 }, false, error],
  });
  const body = lines
    .map((line) => {
      const parsed = JSON.parse(line) as { type?: string; id?: number };
      return parsed.type === "chunk" && parsed.id === promiseId ? failed : line;
    })
    .join("\n");
  await route.fulfill({ response, body: `${body}\n` });
}

test("a streamed part that fails shows its error where it would render", async ({ page }) => {
  await signInToDashboard(page);
  const message =
    "Other open chats could not be loaded: canceling statement due to statement timeout";
  await page.route(EDIT_DATA, (route) => failStreamedPart(route, "otherOpenChats", message));

  await page.getByTestId("nav-live-edit").first().click();
  await expect(page.getByTestId("edit-toolbar")).toBeVisible();
  const banner = page.getByTestId("cross-chat-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(message);
  // The rest of the editor still works: the Staging controls arrive.
  await expect(page.getByTestId("toolbar-publish-loading")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-publish-error")).toHaveCount(0);
});
