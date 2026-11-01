// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PhaseTiming } from "@caelo-cms/shared";
import { estimateStageEta, failedPhaseOf, type StageRunTiming, stagePhaseOf } from "./stage-eta.js";

const T0 = Date.parse("2026-11-01T07:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** A successful Stage: 4 s prepare, 80 s generator (with a breakdown), 10 s publish steps. */
const success: PhaseTiming[] = [
  { phase: "prepare", ms: 4_000 },
  { phase: "generator", ms: 80_000 },
  { phase: "generator.compose", ms: 70_000 },
  { phase: "lock-wait", ms: 1_000 },
  { phase: "publish", ms: 8_000 },
  { phase: "finish", ms: 1_000 },
];

function running(progress: StageRunTiming["progress"]): StageRunTiming {
  return { status: "running", startedAt: at(0), progress };
}

describe("stagePhaseOf", () => {
  it("maps status and progress to the run's step", () => {
    expect(stagePhaseOf({ status: "pending", startedAt: at(0), progress: null })).toBe("queued");
    expect(stagePhaseOf(running(null))).toBe("preparing");
    expect(stagePhaseOf(running({ pagesDone: 3, pagesTotal: 10 }))).toBe("building");
    expect(stagePhaseOf(running({ pagesDone: 10, pagesTotal: 10 }))).toBe("publishing");
    expect(stagePhaseOf({ status: "failed", startedAt: at(0), progress: null })).toBe("failed");
  });
});

describe("failedPhaseOf", () => {
  it("names the last top-level step, skipping the catch-all and breakdowns", () => {
    expect(
      failedPhaseOf([
        { phase: "prepare", ms: 1 },
        { phase: "generator", ms: 2 },
        { phase: "generator.compose", ms: 2 },
        { phase: "failed-step", ms: 0 },
      ]),
    ).toBe("generator");
    expect(failedPhaseOf(null)).toBeNull();
  });
});

describe("estimateStageEta", () => {
  it("uses this run's pace while building, plus the median publish time", () => {
    // 100 pages between the first and the newest write, 20 s apart: 200 ms/page.
    const r = estimateStageEta(
      running({
        pagesDone: 150,
        pagesTotal: 650,
        firstAt: at(10_000),
        firstDone: 50,
        at: at(30_000),
      }),
      [success],
      T0 + 30_000,
    );
    // 500 pages left × 200 ms = 100 s, plus 10 s publish.
    expect(r.eta).toEqual({ remainingMs: 110_000, basis: "this_run_rate", includesPublish: true });
    expect(r.etaUnavailable).toBeNull();
  });

  it("counts the time since the newest write as already spent", () => {
    const r = estimateStageEta(
      running({
        pagesDone: 150,
        pagesTotal: 650,
        firstAt: at(10_000),
        firstDone: 50,
        at: at(30_000),
      }),
      [success],
      T0 + 35_000,
    );
    expect(r.eta?.remainingMs).toBe(105_000);
  });

  it("says when the publish time is not covered (no successful Stage yet)", () => {
    const r = estimateStageEta(
      running({
        pagesDone: 150,
        pagesTotal: 650,
        firstAt: at(10_000),
        firstDone: 50,
        at: at(30_000),
      }),
      [],
      T0 + 30_000,
    );
    expect(r.eta).toEqual({ remainingMs: 100_000, basis: "this_run_rate", includesPublish: false });
  });

  it("falls back to recent successful Stages before the build has a pace", () => {
    const r = estimateStageEta(
      running({ pagesDone: 20, pagesTotal: 650, firstAt: at(5_000), firstDone: 20, at: at(5_000) }),
      [success, success],
      T0 + 6_000,
    );
    // Median total 94 s minus 6 s spent.
    expect(r.eta).toEqual({
      remainingMs: 88_000,
      basis: "last_successful_run",
      includesPublish: true,
    });
  });

  it("estimates a preparing run from the median of recent successful Stages", () => {
    const slow: PhaseTiming[] = [
      { phase: "prepare", ms: 10_000 },
      { phase: "generator", ms: 190_000 },
    ];
    const r = estimateStageEta(running(null), [success, slow, success], T0 + 4_000);
    expect(r.eta).toEqual({
      remainingMs: 90_000,
      basis: "last_successful_run",
      includesPublish: true,
    });
  });

  it("estimates publishing from the median publish time minus the time since the pages finished", () => {
    const r = estimateStageEta(
      running({ pagesDone: 650, pagesTotal: 650, at: at(90_000) }),
      [success],
      T0 + 93_000,
    );
    expect(r.eta).toEqual({
      remainingMs: 7_000,
      basis: "last_successful_run",
      includesPublish: true,
    });
  });

  it("gives no number and says why when nothing measured supports one", () => {
    const none = estimateStageEta(running(null), [], T0 + 1_000);
    expect(none.eta).toBeNull();
    expect(none.etaUnavailable).toContain("no successful Stage");

    const overdue = estimateStageEta(running(null), [success], T0 + 200_000);
    expect(overdue.eta).toBeNull();
    expect(overdue.etaUnavailable).toContain("longer than in recent successful Stages");
  });

  it("gives neither an estimate nor a reason for a finished run", () => {
    const r = estimateStageEta(
      { status: "succeeded", startedAt: at(0), progress: null },
      [success],
      T0,
    );
    expect(r).toEqual({ eta: null, etaUnavailable: null });
  });
});
