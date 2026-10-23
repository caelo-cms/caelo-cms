// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — when a plugin's state in this process changed, so the pinned
 * `# Skills` index of a chat reflects what ran when that chat began.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  noteLocalLoadOutcome,
  pluginFailedHereReason,
  pluginRanHereAt,
  resetLocalLoadOutcomes,
} from "./local-availability.js";

afterEach(resetLocalLoadOutcomes);

describe("local plugin availability", () => {
  it("a first outcome holds for every chat, however old", () => {
    noteLocalLoadOutcome("p", false, "boom");
    // Not loaded in the registry, and never switched: not running at any time.
    expect(pluginRanHereAt("p", 0)).toBe(false);
    expect(pluginFailedHereReason("p")).toBe("boom");
  });

  it("a failure after a chat began leaves that chat with the earlier state", () => {
    noteLocalLoadOutcome("p", true, null);
    const chatStart = Date.now() - 1;
    noteLocalLoadOutcome("p", false, "boom");
    // Now not running (nothing in the registry); it ran when the chat began.
    expect(pluginRanHereAt("p", chatStart)).toBe(true);
    // A chat that starts after the failure sees it not running.
    expect(pluginRanHereAt("p", Date.now() + 1)).toBe(false);
  });

  it("a repeated failure keeps the time of the first one and the latest reason", () => {
    noteLocalLoadOutcome("p", true, null);
    noteLocalLoadOutcome("p", false, "first");
    const afterFailure = Date.now() + 1;
    noteLocalLoadOutcome("p", false, "second");
    expect(pluginRanHereAt("p", afterFailure)).toBe(false);
    expect(pluginFailedHereReason("p")).toBe("second");
  });
});
