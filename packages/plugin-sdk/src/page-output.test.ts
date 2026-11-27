// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { headingLevel, placementStep } from "./page-output.js";

describe("headingLevel (#1755, one rule for observer and audit facts)", () => {
  it("names h1 to h6 and nothing else", () => {
    expect(["h1", "h2", "h3", "h4", "h5", "h6"].map(headingLevel)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(["h0", "h7", "h10", "header", "hr", "H1", ""].map(headingLevel)).toEqual(
      Array(7).fill(null),
    );
  });
});

describe("placementStep (#1651 counting steps)", () => {
  it("steps by thresholds, with the last step past the last one", () => {
    const t = [10, 49];
    expect([1, 10, 11, 49, 50, 300].map((n) => placementStep(n, 10_000, t))).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
  });
  it("puts a module on more than half of the pages in the last step, from halfFrom on", () => {
    expect(placementStep(11, 20, [10, 49], 11)).toBe(2);
    expect(placementStep(10, 15, [10, 49], 11)).toBe(0);
    expect(placementStep(12, 30, [10, 49], 11)).toBe(1);
  });
});
