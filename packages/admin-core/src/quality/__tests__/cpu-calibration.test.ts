// SPDX-License-Identifier: MPL-2.0

/**
 * The CPU slowdown calibration (cpu-calibration.ts): a constant target
 * device (#1370), the loud refusal for a missing, too slow or implausible
 * benchmark, and how the calibration travels with the metrics to the AI
 * (protocol schema + get_quality_audit formatting).
 */

import { describe, expect, it } from "bun:test";
import { formatMetrics } from "../../ai/tools/quality-metrics-format.js";
import {
  assertCpuSlowdownApplied,
  calibrateCpuSlowdown,
  effectiveBenchmarkIndex,
  fastestBenchmarkIndex,
  MAX_BENCHMARK_INDEX,
  TARGET_BENCHMARK_INDEX,
} from "../cpu-calibration.js";
import { LighthouseRunError } from "../lighthouse-extract.js";
import { performanceMetricsFromRuns } from "../lighthouse-metrics.js";
import { performanceMetricsSchema } from "../lighthouse-protocol.js";
import { recordedRuns } from "./fixtures/sample-metrics.js";

describe("calibrateCpuSlowdown (constant target device, #1370)", () => {
  it("targets the mid-tier phone of Lighthouse's calculator anchor (1300 at 3x)", () => {
    expect(TARGET_BENCHMARK_INDEX).toBe(433);
    expect(Math.round(1300 / 3)).toBe(TARGET_BENCHMARK_INDEX);
  });

  it.each([
    [433, 1],
    [1300, 3],
    [1302, 3.01],
    [1326, 3.06],
    [2313, 5.34],
    [3700, 8.55],
  ])("benchmark index %p -> %px", (bi, multiplier) => {
    const c = calibrateCpuSlowdown(bi);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.cpuSlowdownMultiplier).toBe(multiplier);
  });

  it("emulates the same device on every host: the #1370 hosts land within 1% of the target", () => {
    // The calculator curve emulated ~428, ~434 and ~317 on these hosts.
    for (const bi of [1302, 1326, 2313, 3700, 7999]) {
      const c = calibrateCpuSlowdown(bi);
      if (!c.ok) throw new Error(c.message);
      const effective = effectiveBenchmarkIndex(c);
      expect(Math.abs(effective - TARGET_BENCHMARK_INDEX)).toBeLessThanOrEqual(
        TARGET_BENCHMARK_INDEX * 0.01,
      );
    }
  });

  it("refuses a host slower than the target device, with a next step", () => {
    const c = calibrateCpuSlowdown(TARGET_BENCHMARK_INDEX - 1);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.code).toBe("host-too-slow");
      expect(c.benchmarkIndex).toBe(TARGET_BENCHMARK_INDEX - 1);
      expect(c.message).toContain("too slow");
      expect(c.message).toContain("more CPU");
    }
  });

  it("refuses an implausible benchmark instead of throttling by it", () => {
    expect(calibrateCpuSlowdown(MAX_BENCHMARK_INDEX).ok).toBe(true);
    const c = calibrateCpuSlowdown(MAX_BENCHMARK_INDEX + 1);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.code).toBe("benchmark-implausible");
      expect(c.message).toContain("implausible");
    }
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    "refuses an unmeasurable benchmark (%p) instead of defaulting",
    (bi) => {
      const c = calibrateCpuSlowdown(bi);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.code).toBe("benchmark-implausible");
    },
  );

  it("keeps the multiplier between 1x and the docs' 20x ceiling", () => {
    const low = calibrateCpuSlowdown(TARGET_BENCHMARK_INDEX);
    const high = calibrateCpuSlowdown(MAX_BENCHMARK_INDEX);
    if (!low.ok || !high.ok) throw new Error("bounds must calibrate");
    expect(low.cpuSlowdownMultiplier).toBe(1);
    expect(high.cpuSlowdownMultiplier).toBeLessThan(20);
  });
});

describe("assertCpuSlowdownApplied", () => {
  const lhrAt = (cpuSlowdownMultiplier?: number) => ({
    requestedUrl: "http://staging.test/",
    configSettings: { throttling: { cpuSlowdownMultiplier } },
  });

  it("passes a run Lighthouse throttled at the calibrated multiplier", () => {
    expect(() => assertCpuSlowdownApplied(lhrAt(2.5), 2.5)).not.toThrow();
  });

  it("fails a run that fell back to Lighthouse's fixed 4x", () => {
    let caught: unknown;
    try {
      assertCpuSlowdownApplied(lhrAt(4), 2.5);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LighthouseRunError);
    expect((caught as LighthouseRunError).code).toBe("CPU_THROTTLING_NOT_APPLIED");
    expect((caught as LighthouseRunError).message).toContain(
      "at CPU slowdown 4x instead of the calibrated 2.5x",
    );
  });

  it("fails a run whose settings no longer report the multiplier", () => {
    expect(() => assertCpuSlowdownApplied({}, 2.5)).toThrow(/unknown/);
  });
});

describe("fastestBenchmarkIndex", () => {
  it("takes the highest sample: interference only ever lowers one", () => {
    expect(fastestBenchmarkIndex([2104, 1650, 2145])).toBe(2145);
    expect(fastestBenchmarkIndex([900])).toBe(900);
  });

  it("throws on no samples", () => {
    expect(() => fastestBenchmarkIndex([])).toThrow();
  });
});

describe("the calibration on the recorded metrics", () => {
  const metrics = performanceMetricsFromRuns(recordedRuns(), 0);

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
      cpuCalibration: { benchmarkIndex: 2313, cpuSlowdownMultiplier: 5.34 },
    });
    expect(lines).toContain(
      "- CPU throttling 5.34x on an audit host of benchmark index 2313: emulates a phone of benchmark index 433, the same mid-tier phone on every host",
    );
  });

  it("adds no line for an audit recorded before calibration", () => {
    expect(formatMetrics(metrics).some((l) => l.includes("CPU throttling"))).toBe(false);
  });
});
