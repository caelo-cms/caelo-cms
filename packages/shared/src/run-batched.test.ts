// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { runBatched } from "./run-batched.js";

describe("runBatched", () => {
  it("runs every item with at most `parallelism` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runBatched([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      done.push(n);
      inFlight -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it("stops starting new items after the first failure and rejects with it", async () => {
    const started: number[] = [];
    await expect(
      runBatched([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom 2");
        await new Promise((r) => setTimeout(r, 5));
      }),
    ).rejects.toThrow("boom 2");
    expect(started.length).toBeLessThan(6);
  });

  it("handles an empty list and refuses a non-positive parallelism", async () => {
    await runBatched([], 4, async () => {
      throw new Error("never");
    });
    await expect(runBatched([1], 0, async () => {})).rejects.toThrow("positive integer");
  });
});
