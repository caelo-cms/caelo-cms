// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { placementStep } from "./page-output.js";

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
