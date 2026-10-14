// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { checkedAgo, releaseCheckState } from "./updates-display.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("checkedAgo", () => {
  it("says 'just now' under a minute, and for a time in the future", () => {
    expect(checkedAgo(minutesAgo(0), NOW)).toBe("just now");
    expect(checkedAgo(minutesAgo(0.9), NOW)).toBe("just now");
    expect(checkedAgo(minutesAgo(-3), NOW)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(checkedAgo(minutesAgo(1), NOW)).toBe("1 min ago");
    expect(checkedAgo(minutesAgo(40), NOW)).toBe("40 min ago");
    expect(checkedAgo(minutesAgo(59.9), NOW)).toBe("59 min ago");
    expect(checkedAgo(minutesAgo(60), NOW)).toBe("1 h ago");
    expect(checkedAgo(minutesAgo(23 * 60 + 59), NOW)).toBe("23 h ago");
    expect(checkedAgo(minutesAgo(24 * 60), NOW)).toBe("1 day ago");
    expect(checkedAgo(minutesAgo(3 * 24 * 60), NOW)).toBe("3 days ago");
  });
});

describe("releaseCheckState", () => {
  it("never claims 'Up to date' when the check never ran", () => {
    expect(
      releaseCheckState({ latestVersion: null, upgradeAvailable: false, checkedAt: null }, NOW),
    ).toEqual({ kind: "never" });
  });

  it("says the last check failed when it ran without finding a release", () => {
    expect(
      releaseCheckState(
        { latestVersion: null, upgradeAvailable: false, checkedAt: minutesAgo(5) },
        NOW,
      ),
    ).toEqual({ kind: "failed", ago: "5 min ago" });
  });

  it("is up to date, or has an update, with when it checked", () => {
    expect(
      releaseCheckState(
        { latestVersion: "0.10.48", upgradeAvailable: false, checkedAt: minutesAgo(40) },
        NOW,
      ),
    ).toEqual({ kind: "up_to_date", ago: "40 min ago" });
    expect(
      releaseCheckState(
        { latestVersion: "0.10.49", upgradeAvailable: true, checkedAt: minutesAgo(0) },
        NOW,
      ),
    ).toEqual({ kind: "update_available", ago: "just now" });
  });
});
