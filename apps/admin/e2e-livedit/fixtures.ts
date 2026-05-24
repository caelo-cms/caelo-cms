// SPDX-License-Identifier: MPL-2.0

/**
 * Custom Playwright `test` export with two auto-fixtures every
 * scenario inherits:
 *
 *   - `assertNoBrowserConsoleErrors` — fails the test if any
 *     `console.error` / `pageerror` lands in the browser during the
 *     scenario. Catches the regression class step 13 surfaced on
 *     PR #61: HTML `pattern="…"` attributes that compile fine on the
 *     server but throw under Chrome's v-flag regex parser, web-component
 *     upgrade errors, hydration mismatches — none of which surface in
 *     `bun run check`.
 *
 *   - `assertNoBackendErrors` — fails the test if any
 *     `ERR_POSTGRES_SERVER_ERROR` or `[chat-runner] failed to persist`
 *     line lands in admin.log during the scenario's slice (byte offset
 *     scoped, so scenario N doesn't trip on scenario N-1's noise).
 *
 * Scenarios opt in by importing `test` + `expect` from this file
 * instead of `@playwright/test`. No call-site change is otherwise
 * required — the assertions run at teardown.
 */

import { test as base, expect } from "@playwright/test";
import {
  assertNoBackendErrors,
  assertNoBrowserConsoleErrors,
  attachBrowserConsoleErrorTracker,
  snapshotBackendLogOffset,
} from "./helpers.js";

export const test = base.extend<{
  _browserConsoleErrorGuard: undefined;
  _backendLogErrorGuard: undefined;
}>({
  _browserConsoleErrorGuard: [
    async ({ page }, use) => {
      const tracker = attachBrowserConsoleErrorTracker(page);
      await use(undefined);
      assertNoBrowserConsoleErrors(tracker);
    },
    { auto: true },
  ],
  _backendLogErrorGuard: [
    // Playwright requires the first arg to be a destructuring
    // pattern — it inspects the function source to wire fixture
    // dependencies and rejects a plain identifier like `_`. This
    // fixture has zero dependencies, so the pattern is empty.
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture API requires the destructure slot even with zero deps
    async ({}, use) => {
      const tracker = snapshotBackendLogOffset();
      await use(undefined);
      assertNoBackendErrors(tracker);
    },
    { auto: true },
  ],
});

export { expect };
