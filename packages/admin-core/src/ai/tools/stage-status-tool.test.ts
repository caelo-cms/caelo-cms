// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { StageStatusRun } from "@caelo-cms/shared";
import {
  formatStageStatus,
  getStageStatusTool,
  stillRunningStageText,
} from "./stage-status-tool.js";

const runId = "00000000-0000-0000-0000-000000001288";
const runningRun: StageStatusRun = {
  runId,
  targetName: "staging",
  status: "running",
  phase: "building",
  pagesDone: 40,
  pagesTotal: 122,
  startedAt: "2026-11-01T07:37:00.000Z",
  finishedAt: null,
  elapsedMs: 50_000,
  error: null,
  failedPhase: null,
  eta: { remainingMs: 52_000, basis: "this_run_rate", includesPublish: true },
  etaUnavailable: null,
};

describe("stillRunningStageText (#1288)", () => {
  it("points at get_stage_status with the run id, progress and ETA, never at a re-run", () => {
    const text = stillRunningStageText(runId, runningRun);
    expect(text).toContain(`build run ${runId}`);
    expect(text).toContain("Building pages 40 of 122");
    expect(text).toContain("about 52 s left");
    expect(text).toContain(
      `call get_stage_status with deployRunId "${runId}" once that time has passed`,
    );
    expect(text).toContain("not in a loop");
    expect(text).toContain("Do NOT call stage_changes again");
  });

  it("asks again in a minute when the build run does not exist yet", () => {
    const text = stillRunningStageText(runId, null);
    expect(text).toContain("has not started yet");
    expect(text).toContain(`Call get_stage_status with deployRunId "${runId}" in a minute`);
  });

  it("reports the end of a run that finished meanwhile", () => {
    const text = stillRunningStageText(runId, {
      ...runningRun,
      status: "failed",
      phase: "failed",
      error: "122 render failure(s)",
      failedPhase: "generator",
      eta: null,
    });
    expect(text).toContain("Failed in generator");
    expect(text).toContain("call stage_changes again");
  });
});

describe("get_stage_status", () => {
  it("validates its input like the op", () => {
    expect(getStageStatusTool.name).toBe("get_stage_status");
    expect(getStageStatusTool.schema.safeParse({}).success).toBe(true);
    expect(getStageStatusTool.schema.safeParse({ deployRunId: "not-a-uuid" }).success).toBe(false);
  });

  it("prints the asked run and its next call", () => {
    const text = formatStageStatus({ runs: [runningRun] }, { deployRunId: runId });
    expect(text).toBe(
      `Stage build run ${runId} (staging): Building pages 40 of 122 — about 52 s left (from this run's pace).\n` +
        `Next: call get_stage_status with deployRunId "${runId}" once that time has passed — once, not in a loop. Do NOT call stage_changes again; do not tell the operator it is staged yet.`,
    );
  });

  it("says an unknown run may still be merging, and when to stage again", () => {
    const text = formatStageStatus({ runs: [] }, { deployRunId: runId });
    expect(text).toContain(`No Stage build run ${runId}`);
    expect(text).toContain("call stage_changes again");
  });

  it("lists the newest runs and points a succeeded newest run at its quality check", () => {
    const done = {
      ...runningRun,
      status: "succeeded" as const,
      phase: "succeeded" as const,
      eta: null,
      elapsedMs: 95_000,
      pagesDone: 122,
    };
    const text = formatStageStatus({ runs: [done, runningRun] }, {});
    expect(text).toContain("Stage runs, newest first:");
    expect(text).toContain("Succeeded in 1 min 35 s (122 pages)");
    expect(text).toContain(`Newest: Next: call get_quality_audit with deployRunId "${runId}"`);
  });
});
