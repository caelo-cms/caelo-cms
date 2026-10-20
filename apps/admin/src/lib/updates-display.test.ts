// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  autoUpdateModeLine,
  checkedAgo,
  finishLabel,
  historySummary,
  phaseLabel,
  progressSentence,
  RELEASE_CHECK_STALE_MS,
  stoppedBeforeChange,
  UPDATE_PAGE_STATES,
  type UpdatePageInput,
  updatePageState,
} from "./updates-display.js";

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

describe("updatePageState (#861): one state, one primary action", () => {
  const INSTALLED = "0.10.52";
  const LATEST = "0.10.53";
  type Req = NonNullable<UpdatePageInput["request"]>;
  const request = (over: Partial<Req> = {}): Req => ({
    status: "failed",
    targetVersion: LATEST,
    fromVersion: INSTALLED,
    statusReason: null,
    refusalCodes: [],
    ...over,
  });
  const input = (over: Partial<UpdatePageInput> = {}): UpdatePageInput => ({
    canInstall: true,
    canUpgrade: true,
    status: {
      installedVersion: INSTALLED,
      latestVersion: LATEST,
      upgradeAvailable: true,
      checkedAt: minutesAgo(2),
      infraChange: false,
    },
    request: null,
    events: [],
    deadRunLogsUrl: null,
    deadRunContinuable: false,
    scheduler: { lastRunAt: null, lastAction: null, lastVersion: null, lastWaitUntil: null },
    policy: AUTO_POLICY,
    now: NOW,
    installRoute: "in_product",
    selfHosted: false,
    convergeJob: false,
    breakGlassAvailable: true,
    ...over,
  });
  /** Installs automatically, not paused, unchanged since long before the scheduler's tick. */
  const AUTO_POLICY: UpdatePageInput["policy"] = {
    mode: "auto",
    paused: false,
    pausedUntil: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  /** The scheduler decided at 11:00 to wait until tomorrow 03:00. */
  const WAITING: UpdatePageInput["scheduler"] = {
    lastRunAt: "2026-10-14T11:00:00.000Z",
    lastAction: "wait",
    lastVersion: LATEST,
    lastWaitUntil: "2026-10-20T03:00:00.000Z",
  };
  const upToDate = {
    installedVersion: INSTALLED,
    latestVersion: INSTALLED,
    upgradeAvailable: false,
    checkedAt: minutesAgo(2),
    infraChange: null,
  };

  it("lists the nine states in priority order", () => {
    expect([...UPDATE_PAGE_STATES]).toEqual([
      "no_permission",
      "in_progress",
      "interrupted",
      "rolled_back",
      "break_glass",
      "update_available",
      "scheduled",
      "up_to_date",
      "unknown",
    ]);
  });

  it("no_permission: tells a viewer who cannot install that an Owner does, with no action", () => {
    const s = updatePageState(
      input({ canInstall: false, canUpgrade: false, installRoute: "none" }),
    );
    expect(s.kind).toBe("no_permission");
    expect(s.sentence).toBe(
      "v0.10.53 is available. An Owner of this site installs Caelo updates; nothing changes for your work until then.",
    );
    expect(s.action).toEqual({ kind: "none" });
    // Wins over everything else, even a running update.
    const running = updatePageState(
      input({
        canInstall: false,
        canUpgrade: false,
        installRoute: "none",
        request: request({ status: "running" }),
      }),
    );
    expect(running.kind).toBe("no_permission");
    expect(running.sentence).toContain("An Owner is installing v0.10.53");
    // Nothing to install: no permission is not worth a sentence.
    expect(
      updatePageState(input({ canInstall: false, canUpgrade: false, status: upToDate })).kind,
    ).toBe("up_to_date");
  });

  it("in_progress: the timeline is the action; cancel only while it waits", () => {
    const pending = updatePageState(input({ request: request({ status: "pending" }) }));
    expect(pending.kind).toBe("in_progress");
    expect(pending.action).toEqual({ kind: "timeline", cancellable: true });
    expect(pending.sentence).toBe(
      "Caelo installs v0.10.53 as soon as the upgrader starts. You can leave this page.",
    );
    const running = updatePageState(
      input({
        request: request({ status: "running" }),
        events: [{ phase: "verify" }, { phase: "backup" }, { phase: "migrations" }],
      }),
    );
    expect(running.action).toEqual({ kind: "timeline", cancellable: false });
    expect(running.sentence).toBe(
      "Caelo is installing v0.10.53. Step 3 of 5: updating the database. You can leave this page.",
    );
  });

  it("interrupted: a run that died points at its log; one that stopped offers Try again", () => {
    const dead = updatePageState(
      input({ request: request({ status: "running" }), deadRunLogsUrl: "https://logs/x" }),
    );
    expect(dead.kind).toBe("interrupted");
    expect(dead.action).toEqual({ kind: "logs", url: "https://logs/x" });

    const refused = updatePageState(
      input({
        request: request({ status: "refused", statusReason: "signature" }),
        events: [{ phase: "queued" }, { phase: "verify" }, { phase: "finish" }],
      }),
    );
    expect(refused.kind).toBe("interrupted");
    expect(refused.sentence).toBe(
      "The update to v0.10.53 stopped before it changed anything. Your site runs on v0.10.52.",
    );
    expect(refused.detail).toBe("signature");
    expect(refused.action).toEqual({ kind: "install", version: LATEST, label: "Try again…" });

    const partway = updatePageState(
      input({ request: request({ status: "failed" }), events: [{ phase: "roll" }] }),
    );
    expect(partway.sentence).toContain("was interrupted");
  });

  it("#819: a dead converge the Owner may continue offers Continue, with the log beside it", () => {
    const s = updatePageState(
      input({
        convergeJob: true,
        request: request({ status: "running" }),
        deadRunLogsUrl: "https://logs/x",
        deadRunContinuable: true,
      }),
    );
    expect(s.kind).toBe("interrupted");
    expect(s.action).toEqual({ kind: "continue", version: LATEST, logsUrl: "https://logs/x" });
    expect(s.sentence).toContain("picks up where it stopped");
  });

  it("#819: with the converge job, a cloud-setup change the upgrader handed back installs from here", () => {
    const handedBack = request({
      status: "needs_cloud_shell",
      statusReason: "infrastructure contract 8 → 9",
      refusalCodes: ["infra-contract"],
    });
    const s = updatePageState(input({ convergeJob: true, request: handedBack }));
    expect(s.kind).toBe("update_available");
    expect(s.action).toEqual({ kind: "install", version: LATEST, label: `Install v${LATEST}…` });
    // Without the job it stays the step by hand; any other refusal does too.
    expect(updatePageState(input({ request: handedBack })).kind).toBe("break_glass");
    const drift = request({ status: "needs_cloud_shell", refusalCodes: ["install-state-drift"] });
    expect(updatePageState(input({ convergeJob: true, request: drift })).kind).toBe("break_glass");
    // A predicted change (#817) installs from here too.
    const predicted = updatePageState(
      input({
        convergeJob: true,
        status: {
          installedVersion: INSTALLED,
          latestVersion: LATEST,
          upgradeAvailable: true,
          checkedAt: minutesAgo(2),
          infraChange: true,
        },
      }),
    );
    expect(predicted.kind).toBe("update_available");
    expect(predicted.action.kind).toBe("install");
  });

  it("#819: the converge job's opening phase counts as checking the release", () => {
    expect(
      progressSentence({ status: "running", targetVersion: LATEST }, [{ phase: "converge" }]),
    ).toContain("Step 1 of 5: checking the release");
  });

  it("rolled_back: says the site is unchanged and offers Try again", () => {
    const s = updatePageState(input({ request: request({ status: "rolled_back" }) }));
    expect(s.kind).toBe("rolled_back");
    expect(s.sentence).toBe(
      "v0.10.53 did not pass its test. Caelo switched back to v0.10.52; your site is unchanged.",
    );
    expect(s.action).toEqual({ kind: "install", version: LATEST, label: "Try again…" });
  });

  it("break_glass: a refused run asks for Cloud Shell, never next to an Install button", () => {
    const s = updatePageState(
      input({ request: request({ status: "needs_cloud_shell", statusReason: "drift" }) }),
    );
    expect(s.kind).toBe("break_glass");
    expect(s.action).toEqual({ kind: "cloud_shell", version: LATEST });
    expect(s.detail).toBe("drift");
    // Self-hosted: the server, not Cloud Shell.
    const selfHosted = updatePageState(
      input({ selfHosted: true, request: request({ status: "needs_cloud_shell" }) }),
    );
    expect(selfHosted.action).toEqual({ kind: "server_command", version: LATEST });
    expect(selfHosted.sentence).toContain("on your server");
  });

  it("break_glass: a release that changes the cloud setup is recognised before the click (#817)", () => {
    const s = updatePageState(input({ status: { ...input().status, infraChange: true } }));
    expect(s.kind).toBe("break_glass");
    expect(s.sentence).toBe(
      "v0.10.53 also changes settings in your Google Cloud project, which Caelo can't do by itself yet. Install it once from Google Cloud Shell with your Google account.",
    );
    expect(s.action).toEqual({ kind: "cloud_shell", version: LATEST });
  });

  it("no Cloud Shell for this install: no break-glass step, the diagnostic instead", () => {
    // Predicted cloud-setup change on a provider without a Cloud Shell
    // walkthrough (or a misconfigured upgrade command).
    const predicted = updatePageState(
      input({ breakGlassAvailable: false, status: { ...input().status, infraChange: true } }),
    );
    expect(predicted.kind).toBe("update_available");
    expect(predicted.action).toEqual({ kind: "none" });
    expect(predicted.detail).toContain("no Cloud Shell upgrade");
    // A run that asked for Cloud Shell: same, with the run's reason.
    const asked = updatePageState(
      input({
        breakGlassAvailable: false,
        request: request({ status: "needs_cloud_shell", statusReason: "drift" }),
      }),
    );
    expect(asked.kind).toBe("update_available");
    expect(asked.action).toEqual({ kind: "none" });
    expect(asked.detail).toBe(
      "Caelo can't install it by itself, and this install has no Cloud Shell upgrade. drift",
    );
    // Self-hosted without a buildable server command (CAELO_SITE_URL
    // missing): no empty "run the command" step either; the page shows the
    // misconfiguration under the sentence.
    const selfHosted = updatePageState(
      input({
        breakGlassAvailable: false,
        selfHosted: true,
        request: request({ status: "needs_cloud_shell" }),
      }),
    );
    expect(selfHosted.kind).toBe("update_available");
    expect(selfHosted.action).toEqual({ kind: "none" });
    expect(selfHosted.detail).toContain("the upgrade command for your server can't be built");
  });

  it("break_glass for a role that may install but not run the step: names who can", () => {
    const s = updatePageState(
      input({
        canUpgrade: false,
        breakGlassAvailable: false,
        request: request({ status: "needs_cloud_shell", statusReason: "drift" }),
      }),
    );
    expect(s.kind).toBe("break_glass");
    expect(s.action).toEqual({ kind: "none" });
    expect(s.sentence).toContain("an Owner who may change this site's settings");
    expect(s.sentence).not.toContain("Cloud Shell");
    expect(s.detail).toBe("drift");
  });

  it("a stale Cloud Shell request for an installed release stays in the history", () => {
    const s = updatePageState(
      input({
        request: request({ status: "needs_cloud_shell", targetVersion: "0.10.51" }),
      }),
    );
    expect(s.kind).toBe("update_available");
    const superseded = updatePageState(input({ request: request({ status: "superseded" }) }));
    expect(superseded.kind).toBe("update_available");
  });

  it("update_available: one Install button, or the terminal command, or nothing", () => {
    const s = updatePageState(input());
    expect(s.kind).toBe("update_available");
    expect(s.sentence).toBe("v0.10.53 is available.");
    expect(s.detail).toBeNull();
    expect(s.action).toEqual({ kind: "install", version: LATEST, label: "Install v0.10.53…" });
    expect(updatePageState(input({ installRoute: "terminal" })).action).toEqual({
      kind: "terminal",
      version: LATEST,
    });
    expect(updatePageState(input({ installRoute: "none" })).action).toEqual({ kind: "none" });
    // A cancelled attempt is history, not a state.
    expect(updatePageState(input({ request: request({ status: "cancelled" }) })).kind).toBe(
      "update_available",
    );
  });

  it("update_available: with the converge job (#819), a cloud-setup release installs from here", () => {
    const s = updatePageState(
      input({ convergeJob: true, status: { ...input().status, infraChange: true } }),
    );
    expect(s.kind).toBe("update_available");
    expect(s.detail).toBe(
      "This update also changes settings in your Google Cloud project, so it takes a little longer.",
    );
    expect(s.action.kind).toBe("install");
  });

  it("scheduled: names when, and offers Install now", () => {
    const s = updatePageState(input({ scheduler: WAITING }));
    expect(s.kind).toBe("scheduled");
    expect(s.sentence).toBe("v0.10.53 installs automatically on Oct 20 at 03:00 UTC.");
    expect(s.action).toEqual({ kind: "install", version: LATEST, label: "Install now…" });
    // Waiting because paused (no time): not scheduled.
    expect(updatePageState(input({ scheduler: { ...WAITING, lastWaitUntil: null } })).kind).toBe(
      "update_available",
    );
  });

  it("scheduled: the current policy wins over the scheduler's last decision", () => {
    const kind = (policy: Partial<UpdatePageInput["policy"]>) =>
      updatePageState(input({ scheduler: WAITING, policy: { ...AUTO_POLICY, ...policy } })).kind;
    // Switched to "Notify only" after the decision.
    expect(kind({ mode: "notify", updatedAt: "2026-10-14T11:30:00.000Z" })).toBe(
      "update_available",
    );
    // Paused after the decision: until resumed, or until a time still ahead.
    expect(kind({ paused: true, updatedAt: "2026-10-14T11:30:00.000Z" })).toBe("update_available");
    expect(
      kind({
        paused: true,
        pausedUntil: "2026-10-26T00:00:00.000Z",
        updatedAt: WAITING.lastRunAt as string,
      }),
    ).toBe("update_available");
    // A pause that has ended no longer holds.
    expect(kind({ paused: true, pausedUntil: "2026-10-14T00:00:00.000Z" })).toBe("scheduled");
    // Any other change after the decision (kinds, window, waiting times):
    // the scheduler recomputes on its next tick; until then no promise.
    expect(kind({ updatedAt: "2026-10-14T11:30:00.000Z" })).toBe("update_available");
    // The scheduler never ran: no decision to show.
    expect(updatePageState(input({ scheduler: { ...WAITING, lastRunAt: null } })).kind).toBe(
      "update_available",
    );
  });

  it("up_to_date: no action", () => {
    const s = updatePageState(input({ status: upToDate }));
    expect(s.kind).toBe("up_to_date");
    expect(s.sentence).toBe("Your site runs the newest version of Caelo.");
    expect(s.action).toEqual({ kind: "none" });
  });

  it("unknown: never checked, or the check failed — Check now, never 'up to date'", () => {
    const never = updatePageState(
      input({
        status: { ...upToDate, latestVersion: null, checkedAt: null },
      }),
    );
    expect(never.kind).toBe("unknown");
    expect(never.badge.label).toBe("Not checked yet");
    expect(never.action).toEqual({ kind: "check_now" });
    const failed = updatePageState(input({ status: { ...upToDate, latestVersion: null } }));
    expect(failed.badge.label).toBe("Last check failed");
    expect(failed.sentence).toContain("couldn't reach GitHub");
  });

  it("unknown: a day-old 'up to date' is no longer claimed (the check isn't running)", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(
      updatePageState(input({ status: { ...upToDate, checkedAt: at(RELEASE_CHECK_STALE_MS) } }))
        .kind,
    ).toBe("up_to_date");
    const stale = updatePageState(
      input({ status: { ...upToDate, checkedAt: at(RELEASE_CHECK_STALE_MS + 3 * 3_600_000) } }),
    );
    expect(stale.kind).toBe("unknown");
    expect(stale.badge.label).toBe("Check out of date");
    expect(stale.sentence).toBe(
      "Caelo last checked for new releases 1 day ago, so it may not know about a newer one.",
    );
    expect(stale.action).toEqual({ kind: "check_now" });
  });
});

describe("timeline outcomes (#861)", () => {
  it("a run stopped before any change never reads 'Finished'", () => {
    const before = [
      { phase: "queued" },
      { phase: "start" },
      { phase: "verify" },
      { phase: "finish" },
    ] as const;
    expect(stoppedBeforeChange(before)).toBe(true);
    expect(finishLabel("needs_cloud_shell", before)).toBe("Stopped before changing anything");
    expect(finishLabel("refused", before)).toBe("Stopped before changing anything");
    expect(finishLabel("failed", [{ phase: "roll" }])).toBe("Stopped before it finished");
    expect(finishLabel("succeeded", before)).toBe("Installed");
    expect(finishLabel("rolled_back", before)).toBe("Went back to the previous version");
    expect(finishLabel("superseded", before)).toBe("No longer needed");
    expect(phaseLabel("finish", "refused", before)).toBe("Stopped before changing anything");
    expect(phaseLabel("migrations", "running", before)).toBe("Updating the database");
  });
});

describe("section summaries (#861)", () => {
  const policy = {
    mode: "auto",
    autoSecurity: true,
    autoPatch: true,
    autoMinor: false,
    paused: false,
  } as const;

  it("says the automatic-update mode in one line", () => {
    expect(autoUpdateModeLine({ ...policy, mode: "notify" })).toBe(
      "You're notified and install updates yourself.",
    );
    expect(autoUpdateModeLine(policy)).toBe(
      "Installs security fixes and bug-fix releases automatically.",
    );
    expect(
      autoUpdateModeLine({ ...policy, autoSecurity: false, autoPatch: false, paused: true }),
    ).toBe(
      "On, but no kind of release is chosen: you install everything yourself. Paused right now.",
    );
  });

  it("sums up the history: last attempt, outcome, count", () => {
    expect(historySummary([], [], false)).toBe("No updates installed from here yet.");
    expect(
      historySummary(
        [
          { requestedAt: "2026-10-19T09:12:00.000Z", status: "needs_cloud_shell" },
          { requestedAt: "2026-10-17T09:12:00.000Z", status: "succeeded" },
        ],
        [{ phase: "verify" }],
        false,
      ),
    ).toBe("Last attempt Oct 19 at 09:12 UTC: stopped before changing anything · 2 entries");
    expect(
      historySummary([{ requestedAt: "2026-10-17T09:12:00.000Z", status: "succeeded" }], [], false),
    ).toBe("Last attempt Oct 17 at 09:12 UTC: installed · 1 entry");
  });
});
