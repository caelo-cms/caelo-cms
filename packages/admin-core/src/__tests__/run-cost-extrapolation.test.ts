// SPDX-License-Identifier: MPL-2.0

/**
 * issue #280 — unit coverage for the migration cost gate's pure math:
 * money-unit conversion, the progress-weighted extrapolation, and the
 * ceiling comparison assembled by `computeRunCost`. No DB here — the
 * DB roll-up lives in imports.get_run_cost and is covered by integration.
 */

import { describe, expect, it } from "bun:test";
import {
  computeRunCost,
  extrapolateRunCost,
  formatMicrocentsAsMoney,
  MICROCENTS_PER_MAJOR_UNIT,
  majorUnitsToMicrocents,
  microcentsToMajorUnits,
} from "../ops/imports-cost.js";

describe("money-unit conversion", () => {
  it("converts major units to microcents and back losslessly for cent-clean amounts", () => {
    expect(majorUnitsToMicrocents(10)).toBe(1_000_000_000);
    expect(majorUnitsToMicrocents(0.01)).toBe(MICROCENTS_PER_MAJOR_UNIT / 100);
    expect(microcentsToMajorUnits(1_000_000_000)).toBe(10);
    expect(microcentsToMajorUnits(majorUnitsToMicrocents(28.5))).toBeCloseTo(28.5, 8);
  });

  it("rounds sub-microcent precision to the nearest microcent", () => {
    // 1e-9 major = 0.1 microcent → rounds to 0.
    expect(majorUnitsToMicrocents(1e-9)).toBe(0);
  });
});

describe("formatMicrocentsAsMoney", () => {
  it("uses the symbol for known currencies", () => {
    expect(formatMicrocentsAsMoney(1_000_000_000, "EUR")).toBe("€10.00");
    expect(formatMicrocentsAsMoney(1_000_000_000, "USD")).toBe("$10.00");
    expect(formatMicrocentsAsMoney(2_850_000_000, "GBP")).toBe("£28.50");
  });

  it("is case-insensitive on the currency code", () => {
    expect(formatMicrocentsAsMoney(500_000_000, "eur")).toBe("€5.00");
  });

  it("falls back to a code prefix for unknown currencies, never a bare number", () => {
    expect(formatMicrocentsAsMoney(1_000_000_000, "SEK")).toBe("SEK 10.00");
  });
});

describe("extrapolateRunCost", () => {
  it("returns null total when no page is rebuilt yet (no divide-by-zero fiction)", () => {
    const e = extrapolateRunCost({ spentMicrocents: 500_000_000, pagesDone: 0, pagesTotal: 34 });
    expect(e.extrapolatedTotal).toBeNull();
    expect(e.spentSoFar).toBe(500_000_000);
    expect(e.workDone).toBe(0);
    expect(e.workTotal).toBe(34);
  });

  it("scales spent-per-page across the remaining pages", () => {
    // €10 for 12 of 34 pages → per-page 10/12, total 10/12*34 ≈ €28.33.
    const e = extrapolateRunCost({
      spentMicrocents: majorUnitsToMicrocents(10),
      pagesDone: 12,
      pagesTotal: 34,
    });
    expect(microcentsToMajorUnits(e.extrapolatedTotal as number)).toBeCloseTo(28.333, 2);
  });

  it("equals spend once every planned page is done (no remaining work)", () => {
    const e = extrapolateRunCost({
      spentMicrocents: majorUnitsToMicrocents(18),
      pagesDone: 34,
      pagesTotal: 34,
    });
    expect(e.extrapolatedTotal).toBe(majorUnitsToMicrocents(18));
  });

  it("clamps at spend when more pages rebuilt than planned", () => {
    const e = extrapolateRunCost({
      spentMicrocents: majorUnitsToMicrocents(5),
      pagesDone: 40,
      pagesTotal: 34,
    });
    expect(e.extrapolatedTotal).toBe(majorUnitsToMicrocents(5));
  });
});

describe("computeRunCost", () => {
  const base = {
    callCount: 7,
    subagentSessionCount: 3,
    pagesDone: 12,
    pagesTotal: 34,
  };

  it("flags overBudget at the exact ceiling (>= boundary)", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(10),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "EUR",
    });
    expect(c.overBudget).toBe(true);
    expect(c.remainingMicrocents).toBe(0);
  });

  it("is under budget with positive remaining below the ceiling", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(4),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "USD",
    });
    expect(c.overBudget).toBe(false);
    expect(c.remainingMicrocents).toBe(majorUnitsToMicrocents(6));
  });

  it("reports negative remaining once spend overshoots the ceiling", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(13),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "EUR",
    });
    expect(c.overBudget).toBe(true);
    expect(c.remainingMicrocents).toBe(majorUnitsToMicrocents(-3));
  });

  it("has no ceiling semantics when none is set", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(4),
      ceilingMicrocents: null,
      ceilingCurrency: null,
    });
    expect(c.overBudget).toBe(false);
    expect(c.remainingMicrocents).toBeNull();
    expect(c.currencyNote).toBeNull();
  });

  it("surfaces the currency-conversion gap loudly for a non-USD ceiling", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(4),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "EUR",
    });
    expect(c.currencyConversionApplied).toBe(false);
    expect(c.currencyNote).toContain("without an FX rate");
  });

  it("leaves the note null for a USD ceiling (already honest)", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(4),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "usd",
    });
    expect(c.currencyNote).toBeNull();
  });

  it("carries the extrapolation through", () => {
    const c = computeRunCost({
      ...base,
      spentMicrocents: majorUnitsToMicrocents(10),
      ceilingMicrocents: majorUnitsToMicrocents(10),
      ceilingCurrency: "EUR",
    });
    expect(c.extrapolation.workDone).toBe(12);
    expect(c.extrapolation.workTotal).toBe(34);
    expect(microcentsToMajorUnits(c.extrapolation.extrapolatedTotal as number)).toBeCloseTo(
      28.333,
      2,
    );
  });
});
