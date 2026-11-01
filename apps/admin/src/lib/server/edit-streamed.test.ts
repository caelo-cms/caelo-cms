// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { deployStateFromRuns } from "./edit-streamed.js";

const run = (
  id: string,
  targetName: "staging" | "production",
  status: "succeeded" | "failed" | "running",
  extra: { buildId?: string; errorMessage?: string; previewUrl?: string } = {},
) => ({
  id,
  targetName,
  status,
  finishedAt: status === "running" ? null : "2026-10-31T10:00:00.000Z",
  buildId: extra.buildId ?? null,
  errorMessage: extra.errorMessage ?? null,
  ...(extra.previewUrl ? { publishSummary: { previewUrl: extra.previewUrl } } : {}),
});

describe("deployStateFromRuns (#1268)", () => {
  it("finds the last Stage and Publish live and whether live carries that Stage", () => {
    const state = deployStateFromRuns(
      [
        run("p1", "production", "succeeded", { buildId: "s1" }),
        run("s1", "staging", "succeeded", { previewUrl: "https://preview.example" }),
      ],
      false,
    );
    expect(state.lastStaged).toEqual({
      runId: "s1",
      finishedAt: "2026-10-31T10:00:00.000Z",
      previewUrl: "https://preview.example",
    });
    expect(state.lastPublishedLive?.fromRunId).toBe("s1");
    expect(state.productionMatchesStaging).toBe(true);
    expect(state.lastStageFailure).toBeNull();
  });

  it("reports a failed newest Stage and a live site behind the last staged build", () => {
    const state = deployStateFromRuns(
      [
        run("s3", "staging", "failed", { errorMessage: "quality gate" }),
        run("s2", "staging", "succeeded"),
        run("p1", "production", "succeeded", { buildId: "s1" }),
      ],
      false,
    );
    expect(state.lastStageFailure).toEqual({ runId: "s3", error: "quality gate" });
    expect(state.lastStaged?.runId).toBe("s2");
    expect(state.productionMatchesStaging).toBe(false);
  });

  it("knows nothing about the sync before anything was published", () => {
    const state = deployStateFromRuns([run("s1", "staging", "succeeded")], false);
    expect(state.lastPublishedLive).toBeNull();
    expect(state.productionMatchesStaging).toBeNull();
  });
});
