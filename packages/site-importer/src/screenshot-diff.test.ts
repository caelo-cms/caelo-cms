// SPDX-License-Identifier: MPL-2.0

/**
 * issue #250 (WS4) — unit coverage for the source-vs-rebuilt fidelity diff.
 * The structural comparison is a pure function over downscaled RGB grids, so
 * the classifier + metric are testable from hand-built "fixture images"
 * (solid-colour grids standing in for downscaled screenshots) without sharp,
 * Playwright, or a database.
 */

import { describe, expect, it } from "bun:test";
import {
  computeDiffStatus,
  computeFidelityStatus,
  FIDELITY_PASS_MAX,
  FIDELITY_WARN_MAX,
  type PageBand,
  STRUCTURAL_DIFF_COLS,
  STRUCTURAL_DIFF_ROWS,
  structuralDiffFraction,
} from "./screenshot-diff.js";

const COLS = STRUCTURAL_DIFF_COLS;
const ROWS = STRUCTURAL_DIFF_ROWS;

/** Build a `COLS*ROWS*3` RGB grid where a `predicate(row)` selects rows that
 *  get `fill`, all others get `base`. Stands in for a downscaled screenshot. */
function grid(
  base: [number, number, number],
  fill: [number, number, number],
  rows: (r: number) => boolean,
): Uint8Array {
  const g = new Uint8Array(COLS * ROWS * 3);
  for (let r = 0; r < ROWS; r++) {
    const [cr, cg, cb] = rows(r) ? fill : base;
    for (let c = 0; c < COLS; c++) {
      const i = (r * COLS + c) * 3;
      g[i] = cr;
      g[i + 1] = cg;
      g[i + 2] = cb;
    }
  }
  return g;
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

describe("structuralDiffFraction", () => {
  it("identical grids diff at 0 (pass)", () => {
    const a = grid(WHITE, BLACK, () => false);
    const b = grid(WHITE, BLACK, () => false);
    const d = structuralDiffFraction(a, b);
    expect(d.fraction).toBe(0);
    expect(computeFidelityStatus(d.fraction).status).toBe("pass");
  });

  it("a blank rebuild vs a full-colour source diffs at 1 (fail)", () => {
    const source = grid(BLACK, BLACK, () => true); // all black
    const rebuilt = grid(WHITE, WHITE, () => true); // all white
    const d = structuralDiffFraction(source, rebuilt);
    expect(d.fraction).toBe(1);
    expect(computeFidelityStatus(d.fraction).status).toBe("fail");
  });

  it("a small localized change lands in the pass band", () => {
    // Source all white; rebuilt flips only the top ~1/12 of rows to black.
    const source = grid(WHITE, BLACK, () => false);
    const flipUntil = Math.floor(ROWS / 12);
    const rebuilt = grid(WHITE, BLACK, (r) => r < flipUntil);
    const d = structuralDiffFraction(source, rebuilt);
    expect(d.fraction).toBeGreaterThan(0);
    expect(d.fraction).toBeLessThanOrEqual(FIDELITY_PASS_MAX);
    expect(computeFidelityStatus(d.fraction).status).toBe("pass");
  });

  it("a mid-sized divergence lands in the warn band", () => {
    // Flip ~1/5 of the rows: above pass, below fail.
    const source = grid(WHITE, BLACK, () => false);
    const flipUntil = Math.floor(ROWS / 5);
    const rebuilt = grid(WHITE, BLACK, (r) => r < flipUntil);
    const d = structuralDiffFraction(source, rebuilt);
    expect(d.fraction).toBeGreaterThan(FIDELITY_PASS_MAX);
    expect(d.fraction).toBeLessThanOrEqual(FIDELITY_WARN_MAX);
    expect(computeFidelityStatus(d.fraction).status).toBe("warn");
  });

  it("names the vertical band that drifted most", () => {
    const source = grid(WHITE, BLACK, () => false);
    // Change only the bottom third (footer area) → worstBand = bottom.
    const bottomStart = Math.floor((2 * ROWS) / 3);
    const rebuilt = grid(WHITE, BLACK, (r) => r >= bottomStart);
    const d = structuralDiffFraction(source, rebuilt);
    const expected: PageBand = "bottom";
    expect(d.worstBand).toBe(expected);
    expect(d.bands.bottom).toBeGreaterThan(d.bands.top);
    expect(d.bands.bottom).toBeGreaterThan(d.bands.middle);
  });

  it("throws on a grid-size mismatch (caller bug, not bad data)", () => {
    const ok = new Uint8Array(COLS * ROWS * 3);
    const short = new Uint8Array(COLS * ROWS * 3 - 3);
    expect(() => structuralDiffFraction(ok, short)).toThrow(/grid length mismatch/);
  });
});

describe("computeFidelityStatus", () => {
  it("buckets by the fidelity thresholds", () => {
    expect(computeFidelityStatus(0).status).toBe("pass");
    expect(computeFidelityStatus(FIDELITY_PASS_MAX).status).toBe("pass");
    expect(computeFidelityStatus(FIDELITY_PASS_MAX + 0.001).status).toBe("warn");
    expect(computeFidelityStatus(FIDELITY_WARN_MAX).status).toBe("warn");
    expect(computeFidelityStatus(FIDELITY_WARN_MAX + 0.001).status).toBe("fail");
  });

  it("fails loudly on a non-finite/negative fraction (never silent pass)", () => {
    expect(computeFidelityStatus(Number.NaN).status).toBe("fail");
    expect(computeFidelityStatus(-1).status).toBe("fail");
    expect(computeFidelityStatus(Number.NaN).diffPct).toBe(1);
  });

  it("is more lenient than the pixel-exact classifier (asymmetric comparison)", () => {
    // A 0.10 diff is a WARN for the exact Genesis gate but a PASS for the
    // asymmetric import gate — the whole point of the separate thresholds.
    expect(computeDiffStatus(0.1).status).toBe("warn");
    expect(computeFidelityStatus(0.1).status).toBe("pass");
  });
});
