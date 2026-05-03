// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pickVariant } from "./ab-router.js";

describe("ab-router pickVariant", () => {
  const variants = [
    { label: "a", weight: 0.5 },
    { label: "b", weight: 0.5 },
  ];

  it("returns the same variant for the same visitor", () => {
    const v1 = pickVariant("visitor-1", "exp-1", variants);
    const v2 = pickVariant("visitor-1", "exp-1", variants);
    expect(v1).toBe(v2);
  });

  it("distributes ~50/50 across many visitors", () => {
    let aCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const v = pickVariant(`visitor-${i}`, "exp-1", variants);
      if (v === "a") aCount += 1;
    }
    const ratio = aCount / N;
    // Within 10pp of 50/50.
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it("respects weights skewed 80/20", () => {
    const skewed = [
      { label: "a", weight: 0.8 },
      { label: "b", weight: 0.2 },
    ];
    let aCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (pickVariant(`visitor-${i}`, "skew", skewed) === "a") aCount += 1;
    }
    expect(aCount / N).toBeGreaterThan(0.7);
    expect(aCount / N).toBeLessThan(0.9);
  });

  it("returns null on empty variants", () => {
    expect(pickVariant("v", "e", [])).toBeNull();
  });
});
