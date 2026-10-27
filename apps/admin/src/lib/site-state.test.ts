// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type DeployRunSummary, siteStateFrom } from "./site-state.js";

const run = (over: Partial<DeployRunSummary>): DeployRunSummary => ({
  id: "r",
  targetName: "staging",
  status: "succeeded",
  finishedAt: "2026-10-15T10:00:00.000Z",
  buildId: null,
  buildKind: "site",
  ...over,
});

describe("siteStateFrom", () => {
  it("counts draft pages only", () => {
    const s = siteStateFrom(
      [{ status: "draft" }, { status: "published" }, { status: "draft" }],
      [],
    );
    expect(s.draftPageCount).toBe(2);
    expect(s.preview).toBeNull();
    expect(s.live).toBeNull();
    expect(s.liveMatchesPreview).toBeNull();
  });

  it("takes the newest succeeded, finished build per target", () => {
    const s = siteStateFrom(
      [],
      [
        run({ id: "s-running", status: "running", finishedAt: null }),
        run({ id: "s-failed", status: "failed" }),
        run({ id: "s2", finishedAt: "2026-10-15T09:00:00.000Z" }),
        run({ id: "p1", targetName: "production", buildId: "s1" }),
        run({ id: "s1", finishedAt: "2026-10-14T09:00:00.000Z" }),
      ],
    );
    expect(s.preview).toEqual({ runId: "s2", finishedAt: "2026-10-15T09:00:00.000Z" });
    expect(s.live?.runId).toBe("p1");
    // Production was promoted from s1, staging has moved on to s2.
    expect(s.liveMatchesPreview).toBe(false);
  });

  it("matches when production was promoted from the newest staged build", () => {
    const s = siteStateFrom(
      [],
      [run({ id: "p1", targetName: "production", buildId: "s1" }), run({ id: "s1" })],
    );
    expect(s.liveMatchesPreview).toBe(true);
  });

  it("does not compare without a staged build", () => {
    const s = siteStateFrom([], [run({ id: "p1", targetName: "production", buildId: "x" })]);
    expect(s.live?.runId).toBe("p1");
    expect(s.liveMatchesPreview).toBeNull();
  });

  it("looks past a plugin-data build to the build a human published (#1155)", () => {
    const s = siteStateFrom(
      [],
      [
        run({ id: "pd1", targetName: "production", buildId: "pd1", buildKind: "plugin_data" }),
        run({ id: "p1", targetName: "production", buildId: "s1" }),
        run({ id: "s1" }),
      ],
    );
    expect(s.live?.runId).toBe("p1");
    expect(s.liveMatchesPreview).toBe(true);
  });
});
