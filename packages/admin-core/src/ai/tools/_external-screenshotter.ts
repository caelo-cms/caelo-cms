// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — shared Playwright screenshotter seam for the single-page
 * external-sensing tools. `screenshot_external_page`, `inspect_external_page`
 * (screenshot/tokens facets) and `query_page_html` (css/xpath selector
 * modes) all render one external URL / HTML string; they share ONE factory
 * so a test can swap in a fake once and all observe it.
 *
 * BROWSER REUSE (inspect-tooling-redesign §7): the default factory launches
 * ONE Chromium and reuses it across a session's inspects instead of
 * launch+dispose per call (the old per-inspect cold start was a big chunk
 * of the onboarding latency). The shared browser idle-closes after
 * `IDLE_MS`; per-call `dispose()` on the reuse wrapper is a no-op (the idle
 * timer owns teardown). When a test factory is installed we bypass the
 * cache entirely so tests keep full control of the fake's lifecycle.
 *
 * Launching Chromium in unit tests is neither fast nor deterministic —
 * `setExternalScreenshotterForTests` mirrors `setGenesisParityDepsForTests`.
 */

import { createPlaywrightScreenshotter, type Screenshotter } from "@caelo-cms/site-importer";

type ScreenshotterFactory = (opts: {
  allowedHosts: readonly string[];
}) => Promise<Screenshotter | null>;

const defaultFactory: ScreenshotterFactory = (opts) => createPlaywrightScreenshotter(opts);
let factory: ScreenshotterFactory = defaultFactory;
let usingDefault = true;

/** Close the shared browser after this long with no capture/query. */
const IDLE_MS = 60_000;
let shared: Screenshotter | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const s = shared;
    shared = null;
    idleTimer = null;
    s?.dispose().catch(() => undefined);
  }, IDLE_MS);
  // Don't hold the process open just for the idle timer.
  idleTimer.unref?.();
}

/**
 * Wrap the shared instance so each use resets the idle clock and per-call
 * `dispose()` is a no-op — the shared browser lives until idle, not until
 * the first caller finishes.
 */
function reuseWrapper(inner: Screenshotter): Screenshotter {
  return {
    capture: (url, opts) => {
      scheduleIdleClose();
      return inner.capture(url, opts);
    },
    query: (html, opts) => {
      scheduleIdleClose();
      return inner.query(html, opts);
    },
    dispose: async () => {
      /* no-op — the idle timer owns teardown of the shared browser */
    },
  };
}

/** Build (or reuse) a screenshotter, or null when Playwright is unavailable. */
export async function getExternalScreenshotter(opts: {
  allowedHosts: readonly string[];
}): Promise<Screenshotter | null> {
  // Tests install their own factory + own the lifecycle — never cache it.
  if (!usingDefault) return factory(opts);
  if (shared) {
    scheduleIdleClose();
    return reuseWrapper(shared);
  }
  const inst = await factory(opts);
  if (!inst) return null;
  shared = inst;
  scheduleIdleClose();
  return reuseWrapper(shared);
}

/** Test seam — pass null to restore the real Playwright factory. Also tears
 *  down any shared browser so tests start clean. */
export function setExternalScreenshotterForTests(next: ScreenshotterFactory | null): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const s = shared;
  shared = null;
  s?.dispose().catch(() => undefined);
  factory = next ?? defaultFactory;
  usingDefault = next === null;
}
