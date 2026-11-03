// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { comparablePreviousScores } from "./previous-scores.js";

const PREVIOUS = { performance: 97, accessibility: 100, "best-practices": 96, seo: 100 };
const { performance: _cpuDependent, ...WITHOUT_PERFORMANCE } = PREVIOUS;

const none = { multiplier: null, target: null };
const curve = (multiplier: number) => ({ multiplier, target: null });
const target = (multiplier: number) => ({ multiplier, target: 433 });

describe("comparablePreviousScores", () => {
  it("compares every category when both audits emulated the target device, whatever the multiplier (#1370)", () => {
    // Two parallel-task hosts of different speed: 3.06x at 1326, 5.34x at 2313.
    expect(comparablePreviousScores(PREVIOUS, target(3.06), target(5.34))).toEqual(PREVIOUS);
  });

  it("leaves Performance out when the target devices differ", () => {
    expect(
      comparablePreviousScores(
        PREVIOUS,
        { multiplier: 3, target: 433 },
        { multiplier: 3, target: 500 },
      ),
    ).toEqual(WITHOUT_PERFORMANCE);
  });

  it("leaves Performance out against an audit from before #1370 (its device followed the host)", () => {
    expect(comparablePreviousScores(PREVIOUS, curve(3.1), target(3.06))).toEqual(
      WITHOUT_PERFORMANCE,
    );
    expect(comparablePreviousScores(PREVIOUS, target(3.06), curve(3.1))).toEqual(
      WITHOUT_PERFORMANCE,
    );
  });

  it("compares two audits from before #1370 by their multiplier, as they were", () => {
    expect(comparablePreviousScores(PREVIOUS, curve(3.4), curve(3.4))).toEqual(PREVIOUS);
    expect(comparablePreviousScores(PREVIOUS, curve(3.4), curve(2.1))).toEqual(WITHOUT_PERFORMANCE);
  });

  it("compares every category when neither audit recorded a calibration", () => {
    expect(comparablePreviousScores(PREVIOUS, none, none)).toEqual(PREVIOUS);
  });

  it("leaves Performance out against an audit from before calibration", () => {
    // A calibrated score is not a regression against the fixed-4x score
    // recorded before calibration existed.
    expect(comparablePreviousScores(PREVIOUS, none, target(5.2))).toEqual(WITHOUT_PERFORMANCE);
    expect(comparablePreviousScores(PREVIOUS, curve(5.2), none)).toEqual(WITHOUT_PERFORMANCE);
  });
});
