// SPDX-License-Identifier: MPL-2.0

/**
 * Which of a page's Lighthouse runs scores its Performance, and when the
 * page needs more runs first (#874, #1370).
 *
 * A page gets `PERFORMANCE_RUNS` runs (ops/quality/lifecycle.ts). When
 * their Performance scores agree — spread at most
 * `RUN_AGREEMENT_TOLERANCE` points — the best run scores the page (#874):
 * host interference only ever slows a run down, so among runs that agree
 * the fastest is the closest measurement of the page itself.
 *
 * When they disagree, one run is no longer representative: the best of
 * 100/100/91 is a single run, and whether it or the 91 is the page is
 * exactly what the runs cannot agree on. The page then gets confirmation
 * runs up to `MEDIAN_RUNS`, and the median run scores it, the aggregate
 * Lighthouse recommends for exactly this (docs/variability.md, "Run
 * Lighthouse Multiple Times": "The median Lighthouse score of 5 runs is
 * twice as stable as 1 run"; Lighthouse CI collects `-n 5` for the same
 * reason). The median of five needs three runs on the bad side to fail a
 * page, so one disturbed host cannot block Publish live, and one lucky
 * host cannot pass a page that is slow in three of five runs.
 *
 * Why these numbers:
 * - Tolerance = `ACCEPTED_PERFORMANCE_TOLERANCE` (2 points), the observed
 *   measurement noise of the Performance score, so the codebase has one
 *   noise figure, not two. #1370's clean reproduction (one host, constant
 *   target device, 5 runs) spread 99-100: within it. The audit that filed
 *   #1370 had spreads of 0 (99/99/99, the calibration bug) and 9
 *   (100/100/91, host contention): the second is what this catches.
 * - 5 runs: the Lighthouse figure above, and the `auditJobSchema` cap.
 *   Only disagreeing pages pay for the two extra runs.
 */

import { ACCEPTED_PERFORMANCE_TOLERANCE } from "./ratchet.js";

/** Largest Performance-score spread (max - min, points) at which a page's
 *  runs still agree. */
export const RUN_AGREEMENT_TOLERANCE = ACCEPTED_PERFORMANCE_TOLERANCE;

/** Runs a page whose runs disagree is scored over (by their median). */
export const MEDIAN_RUNS = 5;

/** How the scoring run was chosen; travels with the metrics to the AI. */
export type ScoredBy = "best" | "median";

/** True when the scores spread wider than `RUN_AGREEMENT_TOLERANCE`. */
export function runsDisagree(performanceScores: readonly number[]): boolean {
  if (performanceScores.length === 0) return false;
  return Math.max(...performanceScores) - Math.min(...performanceScores) > RUN_AGREEMENT_TOLERANCE;
}

/**
 * Confirmation runs a page still needs before it can be scored: 0 when its
 * runs agree, else enough to reach `MEDIAN_RUNS`.
 *
 * @param performanceScores - the page's 0..100 Performance scores so far.
 */
export function confirmationRunsNeeded(performanceScores: readonly number[]): number {
  if (!runsDisagree(performanceScores)) return 0;
  return Math.max(0, MEDIAN_RUNS - performanceScores.length);
}

function assertSameRuns(
  name: string,
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): void {
  if (performanceScores.length === 0) throw new Error(`${name}: no Performance runs`);
  if (perfOnlyFailures.length !== performanceScores.length) {
    throw new Error(
      `${name}: ${performanceScores.length} Performance score(s) but ${perfOnlyFailures.length} finding count(s); both must list every run`,
    );
  }
}

/**
 * Run indices from best to worst: the highest Performance score, then the
 * fewest failing Performance-only audits, then the earliest run.
 */
function rankRuns(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): number[] {
  return performanceScores
    .map((_, i) => i)
    .sort(
      (a, b) =>
        (performanceScores[b] as number) - (performanceScores[a] as number) ||
        (perfOnlyFailures[a] as number) - (perfOnlyFailures[b] as number) ||
        a - b,
    );
}

/**
 * The index of a page's best Performance run (highest score, then fewest
 * failing Performance-only audits, then earliest).
 *
 * @param performanceScores - each run's 0..100 Performance score, in run order.
 * @param perfOnlyFailures - each run's count of failing Performance-only audits.
 * @throws when there is no run (an infrastructure failure, never a score)
 *   or the two lists do not describe the same runs.
 */
export function bestRunIndex(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): number {
  assertSameRuns("bestRunIndex", performanceScores, perfOnlyFailures);
  return rankRuns(performanceScores, perfOnlyFailures)[0] as number;
}

/**
 * The index of a page's median Performance run: the middle of the runs
 * ranked as `bestRunIndex` ranks them (for an even count, the better of
 * the two middle runs). The score, findings and metrics all come from this
 * one run, so they describe the same measurement.
 *
 * @throws as `bestRunIndex`.
 */
export function medianRunIndex(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): number {
  assertSameRuns("medianRunIndex", performanceScores, perfOnlyFailures);
  const ranked = rankRuns(performanceScores, perfOnlyFailures);
  return ranked[Math.floor((ranked.length - 1) / 2)] as number;
}

/**
 * The run that scores the page, and how it was chosen: the best run when
 * the runs agree, the median run when they disagree.
 *
 * @throws when the runs disagree but fewer than `MEDIAN_RUNS` were taken —
 *   the caller skipped the confirmation runs (`confirmationRunsNeeded`),
 *   and scoring the page anyway would hide that.
 */
export function scoringRun(
  performanceScores: readonly number[],
  perfOnlyFailures: readonly number[],
): { readonly index: number; readonly scoredBy: ScoredBy } {
  if (!runsDisagree(performanceScores)) {
    return { index: bestRunIndex(performanceScores, perfOnlyFailures), scoredBy: "best" };
  }
  if (performanceScores.length < MEDIAN_RUNS) {
    throw new Error(
      `scoringRun: the Performance runs disagree (${performanceScores.join("/")}) but only ${performanceScores.length} of the ${MEDIAN_RUNS} runs a median needs were taken; take confirmationRunsNeeded() more runs first`,
    );
  }
  return { index: medianRunIndex(performanceScores, perfOnlyFailures), scoredBy: "median" };
}
