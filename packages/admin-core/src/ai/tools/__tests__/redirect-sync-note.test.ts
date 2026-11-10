// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — what a redirect tool's result says about where each saved rule is
 * served. A save is Staged (staging now, live with Publish live) or Draft
 * (served nowhere); the staging line tells the truth on every provider —
 * the staging gateway serves the staging view (#1330) — and nothing says
 * "live now". #1357 — a live 410 rule on a host that cannot send 410
 * answers 404.
 */

import { describe, expect, it } from "bun:test";
import { goneStatusOnProvider } from "../../../deploy/static-publisher.js";
import type { RedirectSyncTargetStatus } from "../../../ops/redirect_sync.js";
import type { RedirectReleasePlan } from "../../../ops/redirects_release.js";
import {
  describeRedirectSyncTarget,
  describeSavedRedirects,
  type SavedRedirectChange,
} from "../_redirect-sync-note.js";

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
    live: true,
    failedAttempts: 0,
    nextAttemptAt: null,
    lastError: null,
    goneAnswer,
    last: {
      status: "applied",
      trigger: "publish",
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

const staged = (fromPath: string): SavedRedirectChange => ({
  fromPath,
  outcome: "pending",
  state: "staged",
  replaced: null,
});

const plan = (over: Partial<RedirectReleasePlan> = {}): RedirectReleasePlan => ({
  stagedRunId: "00000000-0000-4000-8000-000000000001",
  goingLive: [],
  waiting: [],
  draft: [],
  problem: null,
  ...over,
});

describe("describeSavedRedirects (#1550)", () => {
  it("a Staged rule is on staging now and live with the next Publish live, never 'live now'", () => {
    const text = describeSavedRedirects([staged("/old")], plan(), null, [target(410, 0)]);
    expect(text).toContain("Staged, on staging now: /old");
    expect(text).toContain("next Publish live");
    expect(text).toContain("The live site is unchanged until Publish live.");
    expect(text).not.toMatch(/live now/i);
    // The retired claim (#1330 made it untrue on every provider).
    expect(text).not.toContain("serves no redirects on staging");
  });

  it("a Staged rule whose target the staged build lacks waits for its target", () => {
    const text = describeSavedRedirects(
      [staged("/promo")],
      plan({
        waiting: [
          {
            id: "c1",
            revision: 1,
            fromPath: "/promo",
            toPath: "/summer",
            statusCode: 302,
            origin: "manual",
            live: null,
            reason: "target",
          },
        ],
      }),
      null,
      [],
    );
    expect(text).toContain("waiting for their target: /promo -> /summer");
    expect(text).not.toContain("on staging now");
  });

  it("a Draft is served nowhere; a rule equal to the live one leaves nothing pending", () => {
    const text = describeSavedRedirects(
      [
        { fromPath: "/later", outcome: "pending", state: "draft", replaced: null },
        { fromPath: "/same", outcome: "unchanged", state: null, replaced: null },
      ],
      null,
      null,
      [],
    );
    expect(text).toContain("Draft, served nowhere: /later");
    expect(text).toContain("Already live as asked, nothing pending: /same");
  });

  it("names what a save replaced", () => {
    const text = describeSavedRedirects(
      [
        {
          ...staged("/x"),
          replaced: '/x: replaced a change to /y (301) from chat "Spring" (Staged)',
        },
      ],
      plan(),
      null,
      [],
    );
    expect(text).toContain(
      'Replaced: /x: replaced a change to /y (301) from chat "Spring" (Staged).',
    );
  });

  it("says why staging cannot be told yet, without claiming anything is live", () => {
    const text = describeSavedRedirects(
      [staged("/old")],
      plan({ problem: "Nothing that Publish live could ship is staged. Stage first." }),
      null,
      [],
    );
    expect(text).toContain("Staged: /old");
    expect(text).toContain("Stage first");
  });
});

describe("describeRedirectSyncTarget — the live hosting (#1157, #1357)", () => {
  it("says nothing while the hosting serves the live redirects", () => {
    expect(describeRedirectSyncTarget(target(410, 0))).toBeNull();
  });

  it("says the live 410 rules answer 404 where the host cannot send 410", () => {
    const line = describeRedirectSyncTarget(target(404, 126));
    expect(line).toContain("126 live 410 rules answer 404 on this hosting, not 410 Gone");
  });

  it("names a single rule in the singular", () => {
    expect(describeRedirectSyncTarget(target(404, 1))).toContain("1 live 410 rule answers 404");
  });

  it("says nothing extra where the host sends 410, or no 410 rule exists", () => {
    expect(describeRedirectSyncTarget(target(410, 126))).toBeNull();
    expect(describeRedirectSyncTarget(target(404, 0))).toBeNull();
    expect(describeRedirectSyncTarget(target(404, null))).toBeNull();
  });

  it("reports a push that failed", () => {
    const line = describeRedirectSyncTarget({ ...target(404, 5), inSync: false, lastError: "403" });
    expect(line).toContain("NOT on the hosting yet");
    expect(line).toContain("403");
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
