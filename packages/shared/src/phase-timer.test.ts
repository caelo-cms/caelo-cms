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

  it("lapParts closes a step as the phases measured inside it plus the rest (#1271)", async () => {
    const t = new PhaseTimer(clock(0, 1, 4, 5, 9, 20));
    const parts = new Map<string, { ms: number }>();
    await t.measure(parts, "compose", () => undefined);
    await t.measure(parts, "compose", async () => undefined);
    t.lapParts(parts, "batches");
    expect(t.phases()).toEqual([
      { phase: "compose", ms: 7 },
      { phase: "batches", ms: 13 },
    ]);
  });

  it("a memory timer records each step's peak RSS and stops sampling when closed (#1271)", async () => {
    const t = PhaseTimer.withMemory();
    try {
      const hold: Uint8Array[] = [];
      const parts = new Map<string, { ms: number; peakRssMb?: number }>();
      await t.measure(parts, "alloc", async () => {
        for (let i = 0; i < 16; i += 1) hold.push(new Uint8Array(4 * 1024 * 1024).fill(i + 1));
        await Bun.sleep(60);
      });
      expect(parts.get("alloc")?.peakRssMb ?? 0).toBeGreaterThan(0);
      t.lap("x");
      expect(t.phases()[0]?.peakRssMb ?? 0).toBeGreaterThan(0);
      expect(hold.length).toBe(16);
      for (const p of t.phases()) expect(phaseTimingSchema.parse(p)).toEqual(p);
    } finally {
      t.close();
    }
  });

  it("include keeps a step's peak RSS", () => {
    const t = new PhaseTimer(clock(0, 1));
    t.include("generator", [{ phase: "compose", ms: 3, peakRssMb: 120 }]);
    expect(t.phases()).toEqual([{ phase: "generator.compose", ms: 3, peakRssMb: 120 }]);
  });
});
