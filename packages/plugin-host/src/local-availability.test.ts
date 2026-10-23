// SPDX-License-Identifier: MPL-2.0

/** #1008 — why a plugin does not run in this process. */

import { afterEach, describe, expect, it } from "bun:test";
import {
  noteLocalLoadOutcome,
  pluginFailedHereReason,
  pluginRunsHere,
  resetLocalLoadOutcomes,
} from "./local-availability.js";

afterEach(resetLocalLoadOutcomes);

describe("local plugin availability", () => {
  it("keeps the latest failure reason and forgets it once the plugin loads", () => {
    noteLocalLoadOutcome("p", false, "first");
    noteLocalLoadOutcome("p", false, "second");
    expect(pluginFailedHereReason("p")).toBe("second");
    noteLocalLoadOutcome("p", true, null);
    expect(pluginFailedHereReason("p")).toBeNull();
  });

  it("a plugin nothing loaded does not run here", () => {
    expect(pluginRunsHere("never-loaded")).toBe(false);
  });
});
