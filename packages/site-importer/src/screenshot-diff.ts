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

// ---------------------------------------------------------------------------
// issue #250 (WS4) — source-vs-rebuilt fidelity diff.
//
// The migration gate compares a page's STORED SOURCE screenshot (the live
// external site, captured during the crawl with all its real assets) against
// a screenshot of the REBUILT Caelo page. That comparison is deliberately
// asymmetric: the rebuilt page is screenshotted from `pages.render_preview`
// HTML rendered as a `data:` document, so it cannot load `/_caelo/media/*`
// (relative URLs, no origin) — real photos/hero images render as blanks on
// the rebuilt side even for a faithful rebuild.
//
// A pixel-exact comparator (`computePixelDiff`) is useless here: font
// hinting + a single un-loaded hero would read as "fail" on a perfect
// rebuild. So WS4 uses a COARSE STRUCTURAL diff instead — downscale both
// renders to a small grid and compare per-cell mean colour. This tolerates
// sub-pixel/asset noise while still catching the failures the gate exists to
// catch: a blank page, the wrong template, a page that never composed. The
// thresholds below are correspondingly more lenient than the pixel-exact
// `computeDiffStatus` buckets (which the Genesis parity gate keeps, since
// that comparison IS symmetric — both sides render from data-URLs with no
// external assets).
// ---------------------------------------------------------------------------

/** Downscale grid used by the structural diff. Taller than wide because
 *  pages are vertical — vertical bands (header / body / footer) are the
 *  structure we care about preserving. */
export const STRUCTURAL_DIFF_COLS = 32;
export const STRUCTURAL_DIFF_ROWS = 48;

/** Vertical region of a page, used for the cheap "what drifted" hint. */
export type PageBand = "top" | "middle" | "bottom";

export interface StructuralDiff {
  /** Mean normalized per-cell colour delta over the whole grid, in [0, 1]. */
  readonly fraction: number;
  /** Which vertical third diverged most — a free "what drifted" signal
   *  (top ≈ header/hero, middle ≈ body, bottom ≈ footer). */
  readonly worstBand: PageBand;
  /** Per-band mean deltas in [0, 1], so callers can quantify the hint. */
  readonly bands: Readonly<Record<PageBand, number>>;
}

/**
 * Fidelity thresholds for the structural (asymmetric) diff. Deliberately
 * looser than the pixel-exact `computeDiffStatus` cutoffs — see the block
 * comment above. `pass` = the rebuild structurally tracks the source;
 * `warn` = a human/AI should look; `fail` = blank / wrong-template / broken.
 * Tunable per telemetry; kept as named constants so the badge UI, the run
 * report, and the verdict tool all read the same numbers.
 */
export const FIDELITY_PASS_MAX = 0.12;
export const FIDELITY_WARN_MAX = 0.25;

/**
 * Classify a structural diff `fraction` (in [0, 1]) into the shared
 * pass/warn/fail enum. NaN / negative inputs fail loudly (they mean the
 * comparison could not be computed — never silently "pass"; CLAUDE.md §2).
 */
export function computeFidelityStatus(fraction: number): DiffResult {
  if (!Number.isFinite(fraction) || fraction < 0) {
    return { status: "fail", diffPct: 1 };
  }
  if (fraction <= FIDELITY_PASS_MAX) return { status: "pass", diffPct: fraction };
  if (fraction <= FIDELITY_WARN_MAX) return { status: "warn", diffPct: fraction };
  return { status: "fail", diffPct: fraction };
}

/**
 * Pure structural diff over two equal-size downscaled RGB grids (row-major,
 * `cols*rows` cells, 3 bytes each). Returns the mean per-cell colour
 * distance normalized to [0, 1] plus a coarse vertical-band breakdown so
 * callers can name the region that drifted most without a second pass.
 *
 * The grids MUST be pre-flattened to RGB (no alpha): a transparent region on
 * one side composited over white on the other would otherwise read as a
 * full-page diff. `computeStructuralDiff` (screenshot.ts) does the sharp
 * resize + flatten; this stays a pure, dependency-free function so the metric
 * is unit-testable from hand-built arrays.
 *
 * @throws if either grid length ≠ cols*rows*3 (a caller bug, not bad data).
 */
export function structuralDiffFraction(
  gridA: Uint8Array,
  gridB: Uint8Array,
  cols: number = STRUCTURAL_DIFF_COLS,
  rows: number = STRUCTURAL_DIFF_ROWS,
): StructuralDiff {
  const expected = cols * rows * 3;
  if (gridA.length !== expected || gridB.length !== expected) {
    throw new Error(
      `structuralDiffFraction: grid length mismatch (expected ${expected} RGB bytes for ${cols}x${rows}, got ${gridA.length} / ${gridB.length})`,
    );
  }
  // Band boundaries by row (top / middle / bottom thirds).
  const bandTopEnd = Math.floor(rows / 3);
  const bandMidEnd = Math.floor((2 * rows) / 3);
  const bandSums: Record<PageBand, number> = { top: 0, middle: 0, bottom: 0 };
  const bandCells: Record<PageBand, number> = { top: 0, middle: 0, bottom: 0 };
  let total = 0;

  for (let r = 0; r < rows; r++) {
    const band: PageBand = r < bandTopEnd ? "top" : r < bandMidEnd ? "middle" : "bottom";
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      // Normalized L1 colour distance for this cell, in [0, 1]. The length
      // check above guarantees these reads are in bounds; `?? 0` satisfies
      // noUncheckedIndexedAccess without a bare non-null assertion.
      const cell =
        (Math.abs((gridA[i] ?? 0) - (gridB[i] ?? 0)) +
          Math.abs((gridA[i + 1] ?? 0) - (gridB[i + 1] ?? 0)) +
          Math.abs((gridA[i + 2] ?? 0) - (gridB[i + 2] ?? 0))) /
        (3 * 255);
      total += cell;
      bandSums[band] += cell;
      bandCells[band] += 1;
    }
  }

  const cellCount = cols * rows;
  const bands: Record<PageBand, number> = {
    top: bandCells.top > 0 ? bandSums.top / bandCells.top : 0,
    middle: bandCells.middle > 0 ? bandSums.middle / bandCells.middle : 0,
    bottom: bandCells.bottom > 0 ? bandSums.bottom / bandCells.bottom : 0,
  };
  const worstBand = (Object.keys(bands) as PageBand[]).reduce((a, b) =>
    bands[b] > bands[a] ? b : a,
  );
  return { fraction: cellCount > 0 ? total / cellCount : 1, worstBand, bands };
}
