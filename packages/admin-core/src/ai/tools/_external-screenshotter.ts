// SPDX-License-Identifier: MPL-2.0

/**
 * issue #278 — the ONE screenshotter seam of the admin. The single-page
 * external-sensing tools (`screenshot_external_page`, `inspect_external_page`,
 * `query_page_html`, `map_external_page_types`), the branch-preview capture
 * on self-hosted installs and the site-import crawl + ground-truth pass all
 * get their browser here, so a test swaps in a fake once and every caller
 * observes it.
 *
 * issue #1217 — where the browser runs depends on the install
 * (`capture/capture-backend.ts`):
 *
 * - GCP: each render is one execution of the capture job; no Chromium in the
 *   admin container.
 * - self-hosted / dev: ONE Chromium in this process, shared across callers
 *   (inspect-tooling-redesign §7: no cold start per inspect), running ONE
 *   render at a time (`capture-slot.ts`) and closing after `IDLE_MS` without
 *   renders. Per-call `dispose()` on the shared wrapper is a no-op.
 * - aws / azure: a screenshotter that refuses every render with the
 *   tracking issue — a loud error per call instead of "Chromium missing".
 *
 * Launching Chromium in unit tests is neither fast nor deterministic —
 * `setExternalScreenshotterForTests` mirrors `setGenesisParityDepsForTests`.
 */

import { createPlaywrightScreenshotter, type Screenshotter } from "@caelo-cms/site-importer";
import { captureBackend } from "../../capture/capture-backend.js";
import { createCaptureSlots, IN_PROCESS_CAPTURE_SLOTS } from "../../capture/capture-slot.js";
import { jobScreenshotter } from "../../capture/job-screenshotter.js";

type ScreenshotterFactory = (opts: {
  allowedHosts: readonly string[];
}) => Promise<Screenshotter | null>;

const defaultFactory: ScreenshotterFactory = (opts) => createPlaywrightScreenshotter(opts);
let factory: ScreenshotterFactory = defaultFactory;
let usingDefault = true;

/** Close the shared browser after this long with no render. */
const IDLE_MS = 60_000;
/** The in-process renders, one at a time. */
const slots = createCaptureSlots(IN_PROCESS_CAPTURE_SLOTS);
let shared: Screenshotter | null = null;
/** Renders started or queued on the shared browser and not yet finished. */
let pending = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // A render still queued or running keeps the browser: the timer only
    // counts idle time (a long crawl queue must not lose its browser).
    if (pending > 0) {
      scheduleIdleClose();
      return;
    }
    const s = shared;
    shared = null;
    s?.dispose().catch(() => undefined);
  }, IDLE_MS);
  // Don't hold the process open just for the idle timer.
  idleTimer.unref?.();
}

/** Run one render on the shared browser: in the slot, counted as pending. */
async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  try {
    return await slots.run(fn);
  } finally {
    pending -= 1;
    scheduleIdleClose();
  }
}

/**
 * Wrap a browser so each render takes the slot and resets the idle clock,
 * and per-call `dispose()` is a no-op — the shared browser lives until idle,
 * not until the first caller finishes. Exported for tests.
 */
export function reuseWrapper(inner: Screenshotter): Screenshotter {
  return {
    capture: (url, opts) => inSlot(() => inner.capture(url, opts)),
    renderHtml: (url, opts) => inSlot(() => inner.renderHtml(url, opts)),
    query: (html, opts) => inSlot(() => inner.query(html, opts)),
    dispose: async () => {
      /* no-op — the idle timer owns teardown of the shared browser */
    },
  };
}

/** Every render refused with the same message (no browser on this install). */
function refusingScreenshotter(message: string): Screenshotter {
  const refuse = async (): Promise<never> => {
    throw new Error(message);
  };
  return { capture: refuse, renderHtml: refuse, query: refuse, dispose: async () => undefined };
}

/**
 * The screenshotter for this install, or null when the in-process Playwright
 * is unavailable (self-hosted without Chromium).
 *
 * REUSE + allowedHosts (in-process): the shared instance closes over the
 * FIRST caller's `allowedHosts` and later callers reuse it as-is. That is
 * safe ONLY because every caller passes the same process-global allowlist
 * (`CAELO_IMPORTER_ALLOWED_HOSTS`, read by `externalFetchAllowedHosts()` and
 * `importerAllowedHosts()`) — the SSRF guard is identical for all of them, so
 * a stale closure can't widen it. If a caller ever needs a per-request
 * allowedHosts, this reuse must key the cache on the host set (or rebuild).
 * The job-backed screenshotter passes the hosts with every order.
 */
export async function getExternalScreenshotter(opts: {
  allowedHosts: readonly string[];
}): Promise<Screenshotter | null> {
  // Tests install their own factory + own the lifecycle — never cache it.
  if (!usingDefault) return factory(opts);
  const backend = captureBackend();
  if (backend.kind === "job") return jobScreenshotter(backend.client, opts.allowedHosts);
  if (backend.kind === "unavailable") return refusingScreenshotter(backend.message);
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
