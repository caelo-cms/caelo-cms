// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import { AUTO_CONVERGE_ON, autoUpdateSummary, pauseSummary } from "./auto-update-display.js";

const POLICY: StoredUpdatePolicy = {
  mode: "auto",
  autoSecurity: true,
  autoPatch: true,
  autoMinor: false,
  autoConverge: false,
  channel: "stable",
  windowStart: "02:00",
  windowEnd: "05:00",
  windowTimezone: "Europe/Berlin",
  soakHours: 24,
  securitySoakHours: 2,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  pausedUntil: null,
  pausedByOwner: false,
  updatedAt: "2026-10-14T00:00:00Z",
};

describe("autoUpdateSummary", () => {
  it("names the kinds in the Owner's words, the window and both waits", () => {
    expect(autoUpdateSummary(POLICY)).toEqual([
      "Installed automatically: security fixes, bug fixes. You are told about everything else and install it yourself.",
      "Only between 02:00 and 05:00 (Europe/Berlin).",
      "Each update waits 24 hours after it comes out; a security fix 2 hours.",
    ]);
  });
  it("notify only: every release is announced, security fixes included", () => {
    expect(autoUpdateSummary({ ...POLICY, mode: "notify" })).toEqual([
      "You are told about every new Caelo release, security fixes included, and install it yourself.",
    ]);
  });
  it("says when nothing installs on its own", () => {
    expect(autoUpdateSummary({ ...POLICY, autoSecurity: false, autoPatch: false })[0]).toContain(
      "no kind of update is ticked",
    );
  });
  it("says when updates that change the Google Cloud project install automatically too (#819)", () => {
    expect(autoUpdateSummary({ ...POLICY, autoConverge: true })).toContain(AUTO_CONVERGE_ON);
    expect(autoUpdateSummary(POLICY)).not.toContain(AUTO_CONVERGE_ON);
    // Only relevant while installing automatically.
    expect(autoUpdateSummary({ ...POLICY, mode: "notify", autoConverge: true })).not.toContain(
      AUTO_CONVERGE_ON,
    );
  });
  it("uses no developer words", () => {
    const text = autoUpdateSummary({ ...POLICY, autoMinor: true, autoConverge: true }).join(" ");
    expect(text).not.toMatch(/patch|minor|soak|converge/i);
  });
});

describe("pauseSummary", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  it("is null when not paused", () => {
    expect(pauseSummary(POLICY, now)).toBeNull();
  });
  it("tells an Owner pause from a failure pause", () => {
    expect(
      pauseSummary(
        { ...POLICY, paused: true, pausedByOwner: true, pausedUntil: "2026-10-20T12:00:00Z" },
        now,
      )?.title,
    ).toBe("Automatic updates paused until 2026-10-20 12:00 UTC");
    expect(
      pauseSummary({ ...POLICY, paused: true, pausedReason: "Rolled back." }, now)?.title,
    ).toContain("after a failed install");
  });
  it("an ended pause says it is ending", () => {
    expect(
      pauseSummary(
        { ...POLICY, paused: true, pausedByOwner: true, pausedUntil: "2026-10-14T11:00:00Z" },
        now,
      )?.title,
    ).toBe("Pause ending");
  });
});
