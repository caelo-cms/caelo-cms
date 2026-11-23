// SPDX-License-Identifier: MPL-2.0

/**
 * The scale gate's think times: how long a client waits before its next
 * call. A real MCP agent waits for its model to write the next tool call,
 * an editor looks at the page before acting; a load without these pauses
 * measures how many calls a second the install survives, not the latency
 * twenty agents and five editors see (docs/dev/scale-gate.md, "Think
 * times").
 *
 * Agents draw from the measured steps in `think-times.json` (written by
 * `measure-think-times.ts`); editors pause a uniform time between their
 * actions. Every client has its own seeded generator, so two runs of the
 * same build wait the same way.
 */

import { readFileSync } from "node:fs";

/** `think-times.json`: the measured agent steps and the editors' pause. */
export interface ThinkTimes {
  /** Where the agent steps were measured, for the report and the docs. */
  readonly source: string;
  /** Seconds from a tool result to the model's next tool call, one per measured step. */
  readonly agentStepSeconds: readonly number[];
  /** The editors' pause between actions, seconds; an assumption until measured. */
  readonly editorPauseSeconds: { readonly min: number; readonly max: number; readonly why: string };
}

/** Read and check `think-times.json`. */
export function loadThinkTimes(path: string): ThinkTimes {
  const t = JSON.parse(readFileSync(path, "utf8")) as ThinkTimes;
  if (!Array.isArray(t.agentStepSeconds) || t.agentStepSeconds.length === 0) {
    throw new Error(
      `${path}: agentStepSeconds is empty — run scripts/scale-gate/measure-think-times.ts`,
    );
  }
  if (t.agentStepSeconds.some((s) => !Number.isFinite(s) || s < 0)) {
    throw new Error(`${path}: agentStepSeconds holds a value that is no duration`);
  }
  const e = t.editorPauseSeconds;
  if (!e || !(e.min >= 0) || !(e.max >= e.min)) {
    throw new Error(`${path}: editorPauseSeconds needs 0 <= min <= max`);
  }
  return t;
}

/** mulberry32: a small seeded generator, uniform in [0, 1). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One client's think times, in milliseconds. */
export interface ThinkSampler {
  /** The wait before an agent's next tool call: one of the measured steps. */
  agentMs(): number;
  /** The wait before an editor's next action. */
  editorMs(): number;
}

/** The think times of client `client` under `seed`. */
export function thinkSampler(times: ThinkTimes, seed: number, client: number): ThinkSampler {
  const next = seeded(seed * 1_000_003 + client);
  const steps = times.agentStepSeconds;
  const { min, max } = times.editorPauseSeconds;
  return {
    agentMs: () => (steps[Math.floor(next() * steps.length)] as number) * 1000,
    editorMs: () => (min + next() * (max - min)) * 1000,
  };
}

/** Mean of the measured agent steps, seconds (for the report). */
export function meanAgentStepSeconds(times: ThinkTimes): number {
  return times.agentStepSeconds.reduce((a, b) => a + b, 0) / times.agentStepSeconds.length;
}
