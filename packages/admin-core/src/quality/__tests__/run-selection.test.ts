// SPDX-License-Identifier: MPL-2.0

/**
 * Which run scores a page (#874, #1370): the best of runs that agree, the
 * median of `MEDIAN_RUNS` when they disagree, and how many confirmation
 * runs a disagreeing page still needs.
 */

import { describe, expect, it } from "bun:test";
import { ACCEPTED_PERFORMANCE_TOLERANCE } from "../ratchet.js";
import {
  bestRunIndex,
  confirmationRunsNeeded,
  MEDIAN_RUNS,
  medianRunIndex,
  RUN_AGREEMENT_TOLERANCE,
  runsDisagree,
  scoringRun,
} from "../run-selection.js";

describe("the agreement rule", () => {
  it("uses the one noise figure of the Performance score, and five runs", () => {
    expect(RUN_AGREEMENT_TOLERANCE).toBe(ACCEPTED_PERFORMANCE_TOLERANCE);
    expect(RUN_AGREEMENT_TOLERANCE).toBe(2);
    expect(MEDIAN_RUNS).toBe(5);
  });

  it.each([
    [[100, 100, 100], false],
    [[99, 99, 99], false],
    // #1370's clean reproduction spread 99-100.
    [[100, 99, 100], false],
    [[100, 98, 99], false],
    [[100, 97, 100], true],
    // #1370's host contention: TBT 40 / 91 / 370 ms.
    [[100, 100, 91], true],
    [[100], false],
    [[], false],
  ])("%p disagree: %p", (scores, disagree) => {
    expect(runsDisagree(scores)).toBe(disagree);
  });
});

describe("confirmationRunsNeeded", () => {
  it("asks for none when the runs agree", () => {
    expect(confirmationRunsNeeded([100, 99, 100])).toBe(0);
  });

  it("asks for runs up to MEDIAN_RUNS when they disagree", () => {
    expect(confirmationRunsNeeded([100, 100, 91])).toBe(2);
    expect(confirmationRunsNeeded([100, 91])).toBe(3);
  });

  it("asks for none once the page has MEDIAN_RUNS runs, however they spread", () => {
    expect(confirmationRunsNeeded([100, 100, 91, 91, 100])).toBe(0);
  });
});

describe("bestRunIndex and medianRunIndex", () => {
  it("rank by score, then the fewest Performance-only findings, then the earliest run", () => {
    expect(bestRunIndex([100, 100, 100], [1, 0, 0])).toBe(1);
    expect(bestRunIndex([98, 100, 100], [0, 0, 0])).toBe(1);
    // ranked: r4 100, r0 99, r2 94 (1 finding), r1 94 (2), r3 91
    expect(medianRunIndex([99, 94, 94, 91, 100], [0, 2, 1, 3, 0])).toBe(2);
  });

  it("take the better middle run for an even count", () => {
    expect(medianRunIndex([90, 100, 95, 80], [0, 0, 0, 0])).toBe(2);
  });

  it("refuse no runs and lists of different runs", () => {
    expect(() => bestRunIndex([], [])).toThrow(/no Performance runs/);
    expect(() => medianRunIndex([100, 99], [0])).toThrow(/2 Performance score\(s\) but 1/);
  });
});

describe("scoringRun", () => {
  it("scores runs that agree by the best one", () => {
    expect(scoringRun([99, 100, 99], [0, 0, 0])).toEqual({ index: 1, scoredBy: "best" });
  });

  it("scores runs that disagree by the median of five", () => {
    expect(scoringRun([100, 100, 91, 91, 100], [0, 0, 1, 1, 0])).toEqual({
      index: 4,
      scoredBy: "median",
    });
    expect(scoringRun([100, 91, 94, 92, 100], [0, 1, 1, 1, 0]).index).toBe(2);
  });

  it("refuses runs that disagree before the confirmation runs, with the next step", () => {
    expect(() => scoringRun([100, 100, 91], [0, 0, 1])).toThrow(/confirmationRunsNeeded/);
  });
});
