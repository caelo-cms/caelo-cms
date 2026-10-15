// SPDX-License-Identifier: MPL-2.0

/**
 * Calibrate Lighthouse's simulated CPU slowdown to the machine the audit
 * runs on.
 *
 * Lighthouse's default `cpuSlowdownMultiplier` is a constant 4x, which
 * emulates a mid-tier phone only when the host is a high-end desktop. The
 * audit runs inside the admin's container (one shared vCPU on Cloud Run),
 * so a fixed 4x over-penalises a slow host and turns its noise into score
 * swings: an unchanged static page measured Total Blocking Time of 0, 110
 * and 226 ms in one audit and flipped between Performance 99 and 100 from
 * Stage to Stage. Calibrating to the host's `benchmarkIndex` makes every
 * install measure against the same target device, whatever it runs on.
 *
 * The formula is the one of Lighthouse's own CPU slowdown calculator
 * (https://lighthouse-cpu-throttling-calculator.vercel.app, linked from
 * docs/throttling.md "Calibrating the CPU slowdown"); its target device is
 * the mid-tier mobile that Lighthouse's mobile defaults emulate.
 */

/** Below this benchmark index the calculator refuses: the host is too slow
 *  to emulate the target device at all. */
export const MIN_BENCHMARK_INDEX = 150;

export type CpuCalibration =
  | { readonly ok: true; readonly benchmarkIndex: number; readonly cpuSlowdownMultiplier: number }
  | { readonly ok: false; readonly benchmarkIndex: number; readonly message: string };

/**
 * The `cpuSlowdownMultiplier` for a host with the given benchmark index.
 *
 * @param benchmarkIndex - Lighthouse's `computeBenchmarkIndex()` result for
 *   the host (the median of several samples, see `medianBenchmarkIndex`).
 * @returns the multiplier rounded to one decimal, or `ok: false` when the
 *   host is too slow to measure reliably — never a silent default.
 */
export function calibrateCpuSlowdown(benchmarkIndex: number): CpuCalibration {
  const bi = Math.round(benchmarkIndex);
  if (!Number.isFinite(benchmarkIndex) || benchmarkIndex < MIN_BENCHMARK_INDEX) {
    return {
      ok: false,
      benchmarkIndex: Number.isFinite(benchmarkIndex) ? bi : 0,
      message: `The audit host is too slow to emulate Lighthouse's target device (benchmark index ${Number.isFinite(benchmarkIndex) ? bi : "unmeasurable"}, needs at least ${MIN_BENCHMARK_INDEX}). Give the admin more CPU and run the check again.`,
    };
  }
  let multiplier: number;
  if (benchmarkIndex >= 1300) multiplier = 3 + (benchmarkIndex - 1300) / 233;
  else if (benchmarkIndex >= 800) multiplier = 2 + (benchmarkIndex - 800) / 500;
  else multiplier = 1 + (benchmarkIndex - 150) / 650;
  return { ok: true, benchmarkIndex: bi, cpuSlowdownMultiplier: Math.round(multiplier * 10) / 10 };
}

/**
 * Median of benchmark samples. A single sample is itself noisy on a shared
 * vCPU, so the child measures a few and takes the middle one.
 *
 * @throws when `samples` is empty (a caller bug, not a measurement).
 */
export function medianBenchmarkIndex(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("medianBenchmarkIndex needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
