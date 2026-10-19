// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6a — axe-core WCAG2AA gating across the authenticated admin
 * surface. Logs in once, walks every list / index route, and asserts
 * zero serious or critical accessibility violations.
 *
 * Routes that need P6.6b interactivity work to clear (Cmd-K palette,
 * notification bell focus traps, drag-and-drop affordances) are
 * marked with a `// TODO(p6.6b)` comment in the deferred-routes block
 * below. The gate fails on any new violation against the baseline
 * routes; deferred ones run informationally via test.skip.
 *
 * #778 — the sweep runs once per colour mode. The Caelatum palette has
 * separate light and night-blue dark tokens, and a contrast regression
 * in one mode is invisible to a light-only sweep.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clearLoginRateBucket } from "./helpers.js";

const BASELINE_ROUTES = [
  "/", // dashboard
  "/content/pages",
  "/content/modules",
  "/content/templates",
  "/content/chat",
  "/content/changes",
  "/settings",
  "/settings/users",
  "/settings/roles",
  "/settings/layouts",
  "/settings/site-defaults",
  "/settings/structured",
  "/settings/deployments",
  "/settings/quality",
  "/settings/domains",
  "/settings/costs",
  "/settings/ai",
  "/settings/updates",
  "/settings/links",
];

/**
 * #781 — the arrival screens (the `(auth)` group) carry the sky + relief
 * plate, with their own colours, so they get their own sweep without a
 * login. `/setup` redirects to `/login` once the first owner exists (it
 * does on the seeded stack) — scanning it still guards the redirect
 * target. `/reset` needs a token in the URL to render its form; the
 * token is only checked on submit.
 */
const ARRIVAL_ROUTES = ["/login", "/setup", "/forgot", "/reset?token=a11y-sweep"];

const COLOR_MODES = ["light", "dark"] as const;

/** Runs axe on the current page and fails with a readable summary on any serious/critical hit. */
async function expectNoBlockingViolations(page: Page, route: string, colorMode: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (blocking.length > 0) {
    // Helpful failure summary — prints rule id + node selector(s)
    // so the regression is easy to locate in the offending page.
    const summary = blocking
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`)
      .join("\n");
    throw new Error(`a11y violations on ${route} (${colorMode}):\n${summary}`);
  }
  expect(blocking.length).toBe(0);
}

/** Pins mode-watcher's colour mode before first paint. */
async function pinColorMode(page: Page, colorMode: string) {
  // mode-watcher reads its mode from localStorage before first paint;
  // pinning it (rather than emulating prefers-color-scheme) keeps the
  // sweep independent of mode-watcher's default.
  await page.addInitScript((mode) => {
    localStorage.setItem("mode-watcher-mode", mode);
  }, colorMode);
}

/** Guards against a silently light-only "dark" run. */
async function expectColorMode(page: Page, colorMode: string) {
  if (colorMode === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
}

test.beforeAll(() => {
  clearLoginRateBucket();
});

for (const colorMode of COLOR_MODES) {
  test.describe(`a11y — WCAG2AA across arrival screens (${colorMode})`, () => {
    test.beforeEach(async ({ page }) => {
      await pinColorMode(page, colorMode);
    });

    for (const route of ARRIVAL_ROUTES) {
      test(`no serious or critical axe violations on ${route}`, async ({ page }) => {
        await page.goto(route);
        await expectColorMode(page, colorMode);
        await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
        await expectNoBlockingViolations(page, route, colorMode);
      });
    }
  });
}

for (const colorMode of COLOR_MODES) {
  test.describe(`a11y — WCAG2AA across authenticated routes (${colorMode})`, () => {
    test.beforeEach(async ({ page }) => {
      await pinColorMode(page, colorMode);
      // Each test logs in independently — clear the per-IP rate bucket
      // so the route sweep doesn't trip the 5-attempts-per-5-min
      // limit on the shared dev-owner credential.
      clearLoginRateBucket();
      await page.goto("/login");
      await page.getByLabel("Email").fill("dev-owner@example.com");
      await page.getByLabel("Password").fill("dev owner password");
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page).toHaveURL("/edit", { timeout: 15_000 });
    });

    for (const route of BASELINE_ROUTES) {
      test(`no serious or critical axe violations on ${route}`, async ({ page }) => {
        await page.goto(route);
        await expectColorMode(page, colorMode);
        // Wait for the route to render past skeleton states.
        await page
          .getByRole("heading")
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {
            /* index routes without a heading still get scanned */
          });
        await expectNoBlockingViolations(page, route, colorMode);
      });
    }
  });
}
