// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { ProgressThrottle } from "../progress-throttle.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("ProgressThrottle (#1003)", () => {
  it("writes the first value at once, coalesces a burst and lands the newest value last", async () => {
    const written: number[] = [];
    const t = new ProgressThrottle<number>(async (v) => {
      written.push(v);
    }, 60_000);
    for (let i = 1; i <= 500; i++) t.offer(i);
    await t.flush();
    expect(written).toEqual([1, 500]);
  });

  it("never runs two writes at once and keeps them in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const written: number[] = [];
    const t = new ProgressThrottle<number>(async (v) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      written.push(v);
      inFlight -= 1;
    }, 0);
    for (let i = 1; i <= 20; i++) {
      t.offer(i);
      await tick(1);
    }
    await t.flush();
    expect(peak).toBe(1);
    expect(written.at(-1)).toBe(20);
    expect([...written].sort((a, b) => a - b)).toEqual(written);
  });

  it("writes again after the interval without a flush", async () => {
    const written: number[] = [];
    const t = new ProgressThrottle<number>(async (v) => {
      written.push(v);
    }, 20);
    t.offer(1);
    t.offer(2);
    await tick(60);
    expect(written).toEqual([1, 2]);
    await t.flush();
    expect(written).toEqual([1, 2]);
  });

  it("swallows a failed write: progress never fails the build it describes", async () => {
    const written: number[] = [];
    const t = new ProgressThrottle<number>(async (v) => {
      if (v === 1) throw new Error("db unavailable");
      written.push(v);
    }, 0);
    t.offer(1);
    await tick(1);
    t.offer(2);
    await t.flush();
    expect(written).toEqual([2]);
  });
});
