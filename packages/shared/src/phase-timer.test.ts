// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { PhaseTimer, phaseTimingSchema } from "./phase-timer.js";

function clock(...ticks: number[]): () => number {
  let i = 0;
  return () => {
    const t = ticks[Math.min(i, ticks.length - 1)];
    i += 1;
    return t ?? 0;
  };
}

describe("PhaseTimer", () => {
  it("each lap measures the time since the previous one", () => {
    const t = new PhaseTimer(clock(0, 10.4, 35.6, 40));
    t.lap("load");
    t.lap("render");
    expect(t.phases()).toEqual([
      { phase: "load", ms: 10 },
      { phase: "render", ms: 25 },
    ]);
    expect(t.totalMs()).toBe(40);
  });

  it("includes steps timed elsewhere under a prefix, before the lap that spans them", () => {
    const t = new PhaseTimer(clock(0, 120));
    t.include("generator", [
      { phase: "compose", ms: 80 },
      { phase: "media", ms: 30 },
    ]);
    t.lap("generator");
    expect(t.phases()).toEqual([
      { phase: "generator.compose", ms: 80 },
      { phase: "generator.media", ms: 30 },
      { phase: "generator", ms: 120 },
    ]);
  });

  it("phases() is a copy and every entry passes the wire schema", () => {
    const t = new PhaseTimer(clock(0, 5));
    t.lap("x");
    t.phases().pop();
    expect(t.phases()).toHaveLength(1);
    for (const p of t.phases()) expect(phaseTimingSchema.parse(p)).toEqual(p);
  });
});
