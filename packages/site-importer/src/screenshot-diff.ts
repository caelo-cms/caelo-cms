// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — screenshot diff classifier.
 *
 * Compares two PNG byte buffers + computes a percent diff bucket
 * (`pass` <5% | `warn` 5-15% | `fail` >15%). The actual pixel
 * comparison is intentionally injectable: the importer's worker
 * takes the screenshot pair via Playwright (or any headless browser),
 * passes the byte buffers + a `pixelDiffPct` callback, and gets a
 * structured DiffResult back.
 *
 * P14 ships the classifier + the gating policy (failed diffs require
 * Owner acknowledgement before production publish). The full
 * Playwright-driven screenshot capture lands in the P14 review pass
 * once the dep tree is willing to carry the Chromium binary.
 */

export type DiffStatus = "pass" | "warn" | "fail";

export interface DiffResult {
  readonly status: DiffStatus;
  readonly diffPct: number;
}

/**
 * Pure classifier. Inputs `diffPct` in [0, 1]; outputs the bucket.
 * Single source of truth so the gating policy stays consistent
 * between the worker (decides whether to gate publish) and the UI
 * (decides what color to render the badge).
 */
export function computeDiffStatus(diffPct: number): DiffResult {
  if (!Number.isFinite(diffPct) || diffPct < 0) {
    return { status: "fail", diffPct: 1 };
  }
  if (diffPct <= 0.05) return { status: "pass", diffPct };
  if (diffPct <= 0.15) return { status: "warn", diffPct };
  return { status: "fail", diffPct };
}

/**
 * Convenience helper: a publish-blocking gate. Returns true when the
 * page may publish to production without Owner acknowledgement.
 */
export function maypublishWithoutAck(status: DiffStatus): boolean {
  return status !== "fail";
}
