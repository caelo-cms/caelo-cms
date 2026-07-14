// SPDX-License-Identifier: MPL-2.0

/**
 * A live run looped screenshot_page × viewports × attempts on 30s timeouts
 * (run-logs/token-efficiency-analysis.md). The timeout result now steers the
 * model to STOP retrying; non-timeout failures stay plain.
 */

import { describe, expect, it } from "bun:test";
import { screenshotFailureContent } from "../screenshot-page.js";

describe("screenshotFailureContent", () => {
  it("adds a do-not-retry steer for timeouts", () => {
    const out = screenshotFailureContent(
      "screenshot 9f082cc7 timed out after 30000ms — operator's browser didn't capture in time",
    );
    expect(out).toContain("Do NOT retry screenshot_page this turn");
    expect(out).toContain("timed out");
    expect(out).toContain("couldn't visually verify");
  });

  it("leaves non-timeout failures plain (no spurious steer)", () => {
    const out = screenshotFailureContent("upload endpoint returned 500");
    expect(out).toBe("screenshot_page failed: upload endpoint returned 500");
    expect(out).not.toContain("Do NOT retry");
  });
});
