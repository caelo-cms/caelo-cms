// SPDX-License-Identifier: MPL-2.0

/**
 * The CPU slowdown calibration (cpu-calibration.ts): the formula of
 * Lighthouse's CPU throttling calculator, the loud refusal for hosts too
 * slow to measure, and how the calibration travels with the metrics to the
 * AI (protocol schema + get_quality_audit formatting).
 */

import { describe, expect, it } from "bun:test";
import { formatMetrics } from "../../ai/tools/quality-metrics-format.js";
import {
  calibrateCpuSlowdown,
  MIN_BENCHMARK_INDEX,
  medianBenchmarkIndex,
} from "../cpu-calibration.js";
import { performanceMetricsFromRuns } from "../lighthouse-metrics.js";
import { performanceMetricsSchema } from "../lighthouse-protocol.js";
import { recordedRuns } from "./fixtures/sample-metrics.js";

describe("calibrateCpuSlowdown (Lighthouse CPU throttling calculator)", () => {
  // Expected values computed by hand from the calculator's three brackets.
  it.each([
    // >= 1300: 3 + (bi - 1300) / 233
    [1300, 3],
    [1533, 4],
    [3171.5, 11],
    // 800..1300: 2 + (bi - 800) / 500
    [800, 2],
    [1050, 2.5],
    // 150..800: 1 + (bi - 150) / 650
    [150, 1],
    [475, 1.5],
  ])("benchmark index %p -> %px", (bi, multiplier) => {
    const c = calibrateCpuSlowdown(bi);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.cpuSlowdownMultiplier).toBe(multiplier);
  });

  it("is continuous at the bracket edges, so a host near an edge does not jump", () => {
    const below = calibrateCpuSlowdown(1299.9);
    const at = calibrateCpuSlowdown(1300);
    expect(below.ok && at.ok).toBe(true);
    if (below.ok && at.ok) expect(at.cpuSlowdownMultiplier - below.cpuSlowdownMultiplier).toBe(0);
  });

  it("refuses a host too slow to emulate the target device, with a next step", () => {
    const c = calibrateCpuSlowdown(MIN_BENCHMARK_INDEX - 1);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.benchmarkIndex).toBe(MIN_BENCHMARK_INDEX - 1);
      expect(c.message).toContain("too slow");
      expect(c.message).toContain("more CPU");
    }
  });

  it("refuses an unmeasurable benchmark instead of defaulting", () => {
    expect(calibrateCpuSlowdown(Number.NaN).ok).toBe(false);
  });
});

describe("medianBenchmarkIndex", () => {
  it("takes the middle sample, so one noisy sample does not decide", () => {
    expect(medianBenchmarkIndex([900, 300, 1000])).toBe(900);
    expect(medianBenchmarkIndex([800, 1000])).toBe(900);
  });

  it("throws on no samples", () => {
    expect(() => medianBenchmarkIndex([])).toThrow();
  });
});

describe("the calibration on the recorded metrics", () => {
  const metrics = performanceMetricsFromRuns(recordedRuns());

  it("is accepted by the protocol schema, and audits recorded before it still parse", () => {
    const calibrated = {
      ...metrics,
      cpuCalibration: { benchmarkIndex: 1050, cpuSlowdownMultiplier: 2.5 },
    };
    expect(performanceMetricsSchema.safeParse(calibrated).success).toBe(true);
    expect(performanceMetricsSchema.safeParse(metrics).success).toBe(true);
  });

  it("is shown to the AI next to the metrics", () => {
    const lines = formatMetrics({
      ...metrics,
      cpuCalibration: { benchmarkIndex: 1050, cpuSlowdownMultiplier: 2.5 },
    });
    expect(lines.some((l) => l.includes("CPU throttling 2.5x") && l.includes("1050"))).toBe(true);
  });

  it("adds no line for an audit recorded before calibration", () => {
    expect(formatMetrics(metrics).some((l) => l.includes("CPU throttling"))).toBe(false);
  });
});
