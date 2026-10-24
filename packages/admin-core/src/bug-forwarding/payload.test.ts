// SPDX-License-Identifier: MPL-2.0

/**
 * #1072 — the intake payload names the release that FILED the report, never
 * the release that happens to send it.
 */

import { describe, expect, it } from "bun:test";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { buildIntakeReport, type ForwardableBugReport, UNKNOWN_FILING_VERSION } from "./payload.js";

const row: ForwardableBugReport = {
  id: "11111111-1111-4111-8111-111111111111",
  fingerprint: null,
  source: "ai",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "screenshot_page",
  title: "screenshot_page ignores selector",
  whatHappened: "screenshot_page({selector:'.hero'}) returned the full page.",
  expected: "A crop of .hero.",
  evidence: null,
  caeloVersion: "0.10.1",
};

describe("buildIntakeReport version", () => {
  it("forwards the stored filing version", async () => {
    const payload = await buildIntakeReport(row);
    expect(payload.caeloVersion).toBe("0.10.1");
    expect(payload.caeloVersion).not.toBe(CAELO_VERSION);
  });

  it("forwards 'unknown' for a row filed before the version was recorded", async () => {
    const payload = await buildIntakeReport({ ...row, caeloVersion: null });
    expect(payload.caeloVersion).toBe(UNKNOWN_FILING_VERSION);
    expect(UNKNOWN_FILING_VERSION).toBe("unknown");
  });
});
