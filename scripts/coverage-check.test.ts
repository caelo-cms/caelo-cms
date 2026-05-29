// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the coverage-gate pure helpers (issue #14). These exercise the
 * parser / ratio / ratchet logic without spawning `bun test` or touching the
 * registry — the orchestration in scripts/coverage-check.ts runs only under
 * `import.meta.main`, so importing the module here is side-effect-free.
 */

import { describe, expect, it } from "bun:test";
import {
  computeOpCoveragePct,
  evaluateTier,
  loadOpCoverageSet,
  loadThresholds,
  parseLcovLinePct,
  round1,
} from "./coverage-check.ts";

describe("round1", () => {
  it("rounds to one decimal place", () => {
    expect(round1(52.34)).toBe(52.3);
    expect(round1(52.35)).toBe(52.4);
    expect(round1(100)).toBe(100);
  });
});

describe("parseLcovLinePct", () => {
  it("pools LF/LH across records (not per-file averaging)", () => {
    // file a: 5/10, file b: 8/10 -> pooled 13/20 = 65.0 (per-file avg would be 65 too,
    // so use asymmetric sizes to distinguish): a 1/1, b 0/99 -> pooled 1/100 = 1.0
    const lcov = "SF:a.ts\nLF:1\nLH:1\nend_of_record\nSF:b.ts\nLF:99\nLH:0\nend_of_record\n";
    expect(parseLcovLinePct(lcov)).toEqual({ pct: 1, linesFound: 100, linesHit: 1 });
  });

  it("computes the expected pooled percentage", () => {
    const lcov = "SF:a.ts\nLF:10\nLH:5\nend_of_record\nSF:b.ts\nLF:10\nLH:8\nend_of_record\n";
    expect(parseLcovLinePct(lcov).pct).toBe(65);
  });

  it("throws on zero lines found rather than returning NaN", () => {
    expect(() => parseLcovLinePct("SF:a.ts\nLF:0\nLH:0\nend_of_record\n")).toThrow(
      /no line-coverage data/,
    );
  });

  it("throws on empty / non-lcov input rather than reporting a fake 0%", () => {
    expect(() => parseLcovLinePct("")).toThrow(/no line-coverage data/);
    expect(() => parseLcovLinePct("not an lcov file at all")).toThrow(/no line-coverage data/);
  });
});

describe("loadOpCoverageSet", () => {
  it("de-dupes, drops blank lines, and tolerates a trailing newline", () => {
    const jsonl = "a.x\nb.y\na.x\n\n  c.z  \n";
    const set = loadOpCoverageSet(jsonl);
    expect([...set].sort()).toEqual(["a.x", "b.y", "c.z"]);
  });

  it("returns an empty set for empty input", () => {
    expect(loadOpCoverageSet("").size).toBe(0);
  });
});

describe("computeOpCoveragePct", () => {
  it("counts each declared op at most once and ignores stray executed names", () => {
    const declared = ["a.x", "a.y", "a.z", "a.w", "b.x", "b.y", "b.z", "b.w", "c.x", "c.y"];
    const executed = new Set(["a.x", "a.y", "a.z", "a.w", "b.x", "b.y", "b.z", "b.w", "stray.op"]);
    const r = computeOpCoveragePct(declared, executed);
    expect(r.pct).toBe(80);
    expect(r.declared).toBe(10);
    expect(r.exercised).toBe(8);
    expect(r.missing).toEqual(["c.x", "c.y"]);
  });

  it("throws on an empty declared set rather than dividing by zero", () => {
    expect(() => computeOpCoveragePct([], new Set())).toThrow(/declared op set is empty/);
  });
});

describe("evaluateTier", () => {
  it("passes when measured > floor", () => {
    expect(evaluateTier("unit", 78, 77).pass).toBe(true);
  });

  it("passes at the exact floor (>=, not >)", () => {
    expect(evaluateTier("unit", 77, 77).pass).toBe(true);
  });

  it("fails when measured is below floor, carrying the numbers", () => {
    expect(evaluateTier("unit", 76.9, 77)).toEqual({
      tier: "unit",
      measured: 76.9,
      floor: 77,
      pass: false,
    });
  });
});

describe("loadThresholds", () => {
  it("accepts a well-formed thresholds object", () => {
    const t = loadThresholds({
      unitLinePct: 33,
      integrationOpPct: 42,
      target: { unitLinePct: 90, integrationOpPct: 80 },
    });
    expect(t.unitLinePct).toBe(33);
    expect(t.integrationOpPct).toBe(42);
  });

  it("rejects (throws) a missing floor", () => {
    expect(() =>
      loadThresholds({ unitLinePct: 33, target: { unitLinePct: 90, integrationOpPct: 80 } }),
    ).toThrow();
  });

  it("rejects an out-of-range floor", () => {
    expect(() =>
      loadThresholds({
        unitLinePct: 150,
        integrationOpPct: 42,
        target: { unitLinePct: 90, integrationOpPct: 80 },
      }),
    ).toThrow();
  });
});
