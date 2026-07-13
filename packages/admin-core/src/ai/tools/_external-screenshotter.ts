// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — shared Playwright screenshotter seam for the single-page
 * external-sensing tools. Both `screenshot_external_page` (visual glance)
 * and `inspect_external_page`'s `screenshot`/`tokens` facets render one
 * external URL; they share ONE factory so a test can swap in a fake
 * capture once and both tools observe it.
 *
 * Launching Chromium in unit tests is neither fast nor deterministic —
 * `setExternalScreenshotterForTests` mirrors `setGenesisParityDepsForTests`.
 */

import { createPlaywrightScreenshotter, type Screenshotter } from "@caelo-cms/site-importer";

type ScreenshotterFactory = (opts: {
  allowedHosts: readonly string[];
}) => Promise<Screenshotter | null>;

let factory: ScreenshotterFactory = (opts) => createPlaywrightScreenshotter(opts);

/** Build a screenshotter (or null when Playwright is unavailable). */
export function getExternalScreenshotter(opts: {
  allowedHosts: readonly string[];
}): Promise<Screenshotter | null> {
  return factory(opts);
}

/** Test seam — pass null to restore the real Playwright factory. */
export function setExternalScreenshotterForTests(next: ScreenshotterFactory | null): void {
  factory = next ?? ((opts) => createPlaywrightScreenshotter(opts));
}
