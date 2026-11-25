// SPDX-License-Identifier: MPL-2.0

/**
 * The scale gate's think times (scripts/scale-gate/think.ts): the measured
 * agent steps load and stay plausible, every client draws its own
 * reproducible pauses, and the measurement reads a step as the gap from a
 * tool result to the model's next message.
 */

import { describe, expect, it } from "bun:test";
import { stepThinkSeconds } from "./scale-gate/measure-think-times.ts";
import { loadThinkTimes, meanAgentStepSeconds, thinkSampler } from "./scale-gate/think.ts";

const TIMES = loadThinkTimes(new URL("./scale-gate/think-times.json", import.meta.url).pathname);

describe("scale-gate think times", () => {
  it("think-times.json holds enough measured steps, each a duration, and names its source", () => {
    expect(TIMES.agentStepSeconds.length).toBeGreaterThanOrEqual(100);
    expect(TIMES.agentStepSeconds.every((s) => s >= 0 && s < 600)).toBe(true);
    expect(TIMES.source).toContain("e2e-livedit");
    // A model step takes seconds: a mean far off says the measurement broke.
    expect(meanAgentStepSeconds(TIMES)).toBeGreaterThan(1);
    expect(meanAgentStepSeconds(TIMES)).toBeLessThan(60);
    expect(TIMES.editorPauseSeconds.min).toBeLessThanOrEqual(TIMES.editorPauseSeconds.max);
  });

  it("draws an agent's waits from the measured steps and an editor's from its range", () => {
    const sampler = thinkSampler(TIMES, 1267, 0);
    const steps = new Set(TIMES.agentStepSeconds.map((s) => s * 1000));
    for (let i = 0; i < 200; i++) expect(steps.has(sampler.agentMs())).toBe(true);
    const { min, max } = TIMES.editorPauseSeconds;
    for (let i = 0; i < 200; i++) {
      const ms = sampler.editorMs();
      expect(ms).toBeGreaterThanOrEqual(min * 1000);
      expect(ms).toBeLessThanOrEqual(max * 1000);
    }
  });

  it("gives the same client the same waits under one seed, and other clients others", () => {
    const run = (seed: number, client: number) => {
      const s = thinkSampler(TIMES, seed, client);
      return Array.from({ length: 20 }, () => s.agentMs());
    };
    expect(run(1267, 3)).toEqual(run(1267, 3));
    expect(run(1267, 3)).not.toEqual(run(1267, 4));
    expect(run(1267, 3)).not.toEqual(run(1268, 3));
  });

  it("measures a step from the tool result to the model's next message only", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 23, 10, 0, s)).toISOString();
    const steps = stepThinkSeconds([
      {
        id: "c1",
        messages: [
          { role: "user", createdAt: at(0) },
          { role: "assistant", createdAt: at(3) },
          { role: "tool", createdAt: at(3) },
          { role: "tool", createdAt: at(4) },
          { role: "assistant", createdAt: at(9) },
          { role: "user", createdAt: at(30) },
          { role: "assistant", createdAt: at(32) },
        ],
      },
    ]);
    // Only tool → assistant counts: the user's turn and the first answer do not.
    expect(steps).toEqual([5]);
  });
});
