// SPDX-License-Identifier: MPL-2.0

/**
 * Calibrate Lighthouse's simulated CPU slowdown to the machine the audit
 * runs on, so every run emulates the SAME device (#1370).
 *
 * Lighthouse's default `cpuSlowdownMultiplier` is a constant 4x, which
 * emulates a mid-tier phone only when the host is a high-end desktop
 * (#773: a fixed 4x on a slow host turned its noise into score swings). The
 * host's speed is Lighthouse's own `benchmarkIndex`, and the simulated
 * device is the host slowed down by the multiplier, so the device's
 * effective benchmark index is `benchmarkIndex / multiplier`. Holding that
 * quotient constant is what "the same target device on every host" means:
 *
 *   cpuSlowdownMultiplier = benchmarkIndex / TARGET_BENCHMARK_INDEX
 *
 * Why not Lighthouse's CPU throttling calculator (used until #1370): its
 * piecewise curve (>= 1300: 3 + (e - 1300) / 233, deployed bundle checked
 * 2026-10-15) is not proportional, so its effective device drifts with the
 * host: 1300 -> 3.0x (433), 1533 -> 4.0x (383), 2313 -> 7.3x (317). Every
 * parallel audit task (#875) runs on its own Cloud Run host, so one audit
 * emulated a ~25% slower phone for one page than for the next, and that
 * page scored 99/99/99 next to identical pages at 100 (#1370).
 *
 * The target, 433, is the device that calculator's own anchor describes
 * (benchmark index 1300 -> 3x: 1300 / 3 = 433) and the one Lighthouse's
 * docs/throttling.md describes for its default: "a constant 4x CPU
 * multiplier [...] moves a typical run in the high-end desktop bracket
 * [benchmark index 1500-2000] somewhere into the mid-tier mobile bracket
 * [125-800]" — the middle of the desktop bracket, 1750, at 4x is 437. It is
 * also what the #1370 reproduction measured (8.6x on a ~3700 host, ~430).
 * https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md
 */

import { LighthouseRunError } from "./lighthouse-extract.js";

/** The benchmark index of the device every run emulates: a mid-tier phone.
 *  It is also the slowest host the audit accepts: Lighthouse only slows a
 *  CPU down, so a slower host (multiplier below 1) cannot emulate it. */
export const TARGET_BENCHMARK_INDEX = 433;

/** Above this the benchmark is implausible, not a fast host: the fastest
 *  hosts seen measure ~3700 (#1370), so 8000 is twice that. It caps the
 *  multiplier at ~18.5x, inside the 5-20x Lighthouse's docs give for
 *  emulating a low-end phone on a high-end desktop. */
export const MAX_BENCHMARK_INDEX = 8000;

export type CpuCalibration =
  | { readonly ok: true; readonly benchmarkIndex: number; readonly cpuSlowdownMultiplier: number }
  | {
      readonly ok: false;
      /** `host-too-slow`: below the target; `benchmark-implausible`: no
       *  number, or one no real host measures. */
      readonly code: "host-too-slow" | "benchmark-implausible";
      readonly benchmarkIndex: number;
      readonly message: string;
    };

/**
 * The `cpuSlowdownMultiplier` for a host with the given benchmark index.
 *
 * @param benchmarkIndex - Lighthouse's `computeBenchmarkIndex()` result for
 *   the host (the fastest of several samples, see `fastestBenchmarkIndex`).
 * @returns `benchmarkIndex / TARGET_BENCHMARK_INDEX` rounded to two
 *   decimals (the rounding moves the emulated device by under 0.5%), or
 *   `ok: false` when the benchmark is missing, too slow or implausible —
 *   never a silent default.
 */
export function calibrateCpuSlowdown(benchmarkIndex: number): CpuCalibration {
  if (!Number.isFinite(benchmarkIndex)) {
    return {
      ok: false,
      code: "benchmark-implausible",
      benchmarkIndex: 0,
      message:
        "Lighthouse's CPU benchmark returned no number on the audit host, so the run cannot be calibrated to the target device. Run the check again; if it repeats, a Lighthouse upgrade changed `computeBenchmarkIndex`.",
    };
  }
  const bi = Math.round(benchmarkIndex);
  if (benchmarkIndex < TARGET_BENCHMARK_INDEX) {
    return {
      ok: false,
      code: "host-too-slow",
      benchmarkIndex: bi,
      message: `The audit host is too slow to emulate Lighthouse's target device (benchmark index ${bi}, needs at least ${TARGET_BENCHMARK_INDEX}). Give the audit more CPU and run the check again.`,
    };
  }
  if (benchmarkIndex > MAX_BENCHMARK_INDEX) {
    return {
      ok: false,
      code: "benchmark-implausible",
      benchmarkIndex: bi,
      message: `Lighthouse's CPU benchmark measured an implausible ${bi} on the audit host (above ${MAX_BENCHMARK_INDEX}), so the run cannot be calibrated to the target device. Run the check again; if it repeats, a Lighthouse upgrade changed \`computeBenchmarkIndex\`.`,
    };
  }
  const multiplier = benchmarkIndex / TARGET_BENCHMARK_INDEX;
  return {
    ok: true,
    benchmarkIndex: bi,
    cpuSlowdownMultiplier: Math.round(multiplier * 100) / 100,
  };
}

/** The benchmark index of the device a calibrated run emulated. */
export function effectiveBenchmarkIndex(c: {
  readonly benchmarkIndex: number;
  readonly cpuSlowdownMultiplier: number;
}): number {
  return Math.round(c.benchmarkIndex / c.cpuSlowdownMultiplier);
}

/**
 * The fastest of several benchmark samples. Interference on a shared vCPU
 * only ever lowers a sample, never raises it, so the highest one is the
 * host's own speed: the slowdown is calibrated to the undisturbed host. A
 * low sample would under-throttle every run.
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
