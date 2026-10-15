// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { comparablePreviousScores } from "./previous-scores.js";

const PREVIOUS = { performance: 97, accessibility: 100, "best-practices": 96, seo: 100 };

describe("comparablePreviousScores", () => {
  it("compares every category when both audits ran at the same CPU calibration", () => {
    expect(comparablePreviousScores(PREVIOUS, 3.4, 3.4)).toEqual(PREVIOUS);
  });

  it("compares every category when neither audit recorded a calibration", () => {
    expect(comparablePreviousScores(PREVIOUS, null, null)).toEqual(PREVIOUS);
  });

  it("leaves Performance out when the calibrations differ", () => {
    const { performance: _cpuDependent, ...rest } = PREVIOUS;
    expect(comparablePreviousScores(PREVIOUS, 3.4, 2.1)).toEqual(rest);
  });

  it("leaves Performance out against an audit from before calibration", () => {
    // After calibration shipped: a fast host's calibrated score is not a
    // regression against the fixed-4x score recorded before it.
    const { performance: _cpuDependent, ...rest } = PREVIOUS;
    expect(comparablePreviousScores(PREVIOUS, null, 5.2)).toEqual(rest);
    expect(comparablePreviousScores(PREVIOUS, 5.2, null)).toEqual(rest);
  });
});
