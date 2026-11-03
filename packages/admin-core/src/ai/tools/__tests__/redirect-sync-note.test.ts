// SPDX-License-Identifier: MPL-2.0

/**
 * #1357 — a 410 rule on a host that cannot send 410 (Firebase Hosting, the
 * GCP load balancer, Front Door) answers 404. The redirect tools' result
 * line said "live now" for them; it must say they answer 404.
 */

import { describe, expect, it } from "bun:test";
import { goneStatusOnProvider } from "../../../deploy/static-publisher.js";
import type { RedirectSyncTargetStatus } from "../../../ops/redirect_sync.js";
import { describeRedirectSyncTarget } from "../_redirect-sync-note.js";

function target(
  goneAnswer: 410 | 404,
  goneCount: number | null,
  over: Partial<NonNullable<RedirectSyncTargetStatus["last"]>> = {},
): RedirectSyncTargetStatus {
  return {
    targetId: "t1",
    targetName: "production",
    env: "production",
    inSync: true,
    failedAttempts: 0,
    nextAttemptAt: null,
    lastError: null,
    goneAnswer,
    last: {
      status: "applied",
      trigger: "save",
      finishedAt: "2026-11-02T18:00:00.000Z",
      redirectCount: 3,
      goneCount,
      unservedTargets: [],
      location: "sites/x/versions/v1",
      error: null,
      ...over,
    },
  };
}

describe("describeRedirectSyncTarget — 410 rules (#1357)", () => {
  it("says the 410 rules answer 404 where the host cannot send 410", () => {
    const line = describeRedirectSyncTarget(target(404, 126));
    expect(line).toContain("live now");
    expect(line).toContain("126 410 rules answer 404 on this hosting, not 410 Gone");
  });

  it("names a single rule in the singular", () => {
    expect(describeRedirectSyncTarget(target(404, 1))).toContain("1 410 rule answers 404");
  });

  it("says nothing extra where the host sends 410, or no 410 rule exists", () => {
    expect(describeRedirectSyncTarget(target(410, 126))).not.toContain("404 on this hosting");
    expect(describeRedirectSyncTarget(target(404, 0))).not.toContain("410");
    expect(describeRedirectSyncTarget(target(404, null))).not.toContain("410");
  });

  it("leaves a target that is not live yet as it was", () => {
    const line = describeRedirectSyncTarget({ ...target(404, 5), inSync: false });
    expect(line).toContain("NOT live yet");
    expect(line).not.toContain("410");
  });
});

describe("goneStatusOnProvider (#1357)", () => {
  it("knows which hosts answer a bare 410", () => {
    expect(goneStatusOnProvider(undefined)).toBe(410);
    expect(goneStatusOnProvider("self-hosted")).toBe(410);
    expect(goneStatusOnProvider("aws")).toBe(410);
    expect(goneStatusOnProvider("gcp-firebase")).toBe(404);
    expect(goneStatusOnProvider("gcp")).toBe(404);
    expect(goneStatusOnProvider("azure")).toBe(404);
  });

  it("fails loudly on an unknown provider", () => {
    expect(() => goneStatusOnProvider("heroku")).toThrow(/unknown CAELO_PROVIDER='heroku'/);
  });
});
