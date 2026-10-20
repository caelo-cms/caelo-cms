// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type ActiveRequest, deadRunOf, type LatestRun } from "./update-dead-run.js";

const OPTS = { canInstall: true, logsUrl: "https://console.cloud.google.com/run/jobs" };
const run = (execution: string, state: LatestRun["state"]): LatestRun => ({
  execution,
  state,
  logsUrl: `https://logs/${execution}`,
});
const converge = (execution: string | null): ActiveRequest => ({
  status: "running",
  route: "converge",
  execution,
});

describe("deadRunOf", () => {
  it("a named execution that Cloud Run says ended is dead; a converge may continue", () => {
    expect(deadRunOf(converge("c-1"), run("c-1", "failed"), OPTS)).toEqual({
      logsUrl: "https://logs/c-1",
      continuable: true,
    });
    expect(deadRunOf(converge("c-1"), run("c-1", "running"), OPTS)).toBeNull();
    // A newer run of the job is not this request's.
    expect(deadRunOf(converge("c-1"), run("c-2", "failed"), OPTS)).toBeNull();
  });

  it("#883 review: a converge with no execution and no live run is continuable at once", () => {
    // Stage 1 handed over; stage 2 never started (its start failed).
    expect(deadRunOf(converge(null), run("c-1", "succeeded"), OPTS)).toEqual({
      logsUrl: "https://logs/c-1",
      continuable: true,
    });
    // The job never ran at all.
    expect(deadRunOf(converge(null), null, OPTS)).toEqual({
      logsUrl: OPTS.logsUrl,
      continuable: true,
    });
  });

  it("a converge with no execution while a run lives is still starting, not dead", () => {
    expect(deadRunOf(converge(null), run("c-2", "running"), OPTS)).toBeNull();
  });

  it("only the Owner may continue, and an app-roll run is never continued", () => {
    expect(
      deadRunOf(converge("c-1"), run("c-1", "failed"), { ...OPTS, canInstall: false })?.continuable,
    ).toBe(false);
    const roll: ActiveRequest = { status: "running", route: "app_roll", execution: "u-1" };
    expect(deadRunOf(roll, run("u-1", "failed"), OPTS)?.continuable).toBe(false);
    // An app-roll request always names its execution once claimed.
    expect(deadRunOf({ ...roll, execution: null }, null, OPTS)).toBeNull();
  });

  it("nothing is dead unless the request is running", () => {
    for (const status of ["pending", "succeeded", "failed"]) {
      expect(deadRunOf({ ...converge(null), status }, null, OPTS)).toBeNull();
    }
    expect(deadRunOf(null, null, OPTS)).toBeNull();
  });
});
