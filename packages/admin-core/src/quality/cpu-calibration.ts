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
 * The formula is the one of Lighthouse's own CPU slowdown calculator,
 * which Lighthouse's docs/throttling.md ("Calibrating the CPU slowdown")
 * names as the way to pick the multiplier from a benchmark index, and which
 * Lighthouse's own lr-mobile-config.js cites for its 1.2x. The calculator
 * (https://lighthouse-cpu-throttling-calculator.vercel.app) has no
 * published source repository; its deployed page bundle
 * (`/_next/static/chunks/pages/index-aa3a827a64f39d8cb4a3.js`, checked
 * 2026-10-15) computes, for benchmark index `e`:
 *
 *   e >= 1300: 3 + (e - 1300) / 233
 *   e >=  800: 2 + (e -  800) / 500
 *   e >=  150: 1 + (e -  150) / 650
 *   else:      "This device is too slow to accurately emulate the target
 *               Lighthouse device."
 *
 * and shows the multiplier with `toFixed(1)`. This file reproduces exactly
 * that. Its target device is the mid-tier mobile that Lighthouse's mobile
 * defaults emulate (docs/throttling.md: the default 4x moves a high-end
 * desktop into the mid-tier mobile bracket — 1533 maps to 4.0 here).
 */

import { LighthouseRunError } from "./lighthouse-extract.js";

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
 *   the host (the fastest of several samples, see `fastestBenchmarkIndex`).
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
 * The fastest of several benchmark samples. Interference on a shared vCPU
 * only ever lowers a sample, never raises it, so the highest one is the
 * host's own speed. That is the same reasoning as scoring a page by its
 * best run (#874, `bestRunIndex` in lighthouse-extract.ts): the slowdown is
 * calibrated to the undisturbed host, and the run it is applied to is the
 * undisturbed one. A low sample would under-throttle every run.
 *
 * @throws when `samples` is empty (a caller bug, not a measurement).
 */
export function fastestBenchmarkIndex(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("fastestBenchmarkIndex needs at least one sample");
  return Math.max(...samples);
}

/**
 * Throws unless Lighthouse actually applied the calibrated CPU slowdown to
 * this run: its `configSettings.throttling.cpuSlowdownMultiplier` must
 * equal the multiplier the audit asked for. A Lighthouse upgrade that
 * ignores or renames the `throttling` flag would otherwise audit at the
 * fixed default 4x while the result claims the calibration.
 *
 * @param lhr - the run's Lighthouse result.
 * @param expected - the calibrated multiplier passed as the flag.
 * @throws LighthouseRunError (`CPU_THROTTLING_NOT_APPLIED`) on a mismatch.
 */
export function assertCpuSlowdownApplied(
  lhr: {
    readonly requestedUrl?: string;
    readonly configSettings?: {
      readonly throttling?: { readonly cpuSlowdownMultiplier?: number };
    };
  },
  expected: number,
): void {
  const applied = lhr.configSettings?.throttling?.cpuSlowdownMultiplier;
  if (applied !== expected) {
    throw new LighthouseRunError(
      "CPU_THROTTLING_NOT_APPLIED",
      `Lighthouse ran ${lhr.requestedUrl ?? "the page"} at CPU slowdown ${applied ?? "unknown"}x instead of the calibrated ${expected}x — the throttling override no longer reaches Lighthouse (check its flags after an upgrade).`,
    );
  }
}
