// SPDX-License-Identifier: MPL-2.0

/**
 * The automatic-update decision (epic #696 Phase 5): given the Owner's
 * policy, the installed and the newest release, and what the release's
 * manifest says about it, what the scheduler inside the admin does now.
 *
 * Pure and table-tested (auto-update.test.ts). The scheduler
 * (admin-core platform-updates/scheduler.ts) gathers the inputs, this
 * decides, the `platform_updates.scheduler_tick` op records the decision,
 * queues the install and the Owner's emails.
 *
 * The scheduler is not the trust boundary. It reads the manifest without
 * checking its signature (the admin image ships no cosign), so it only
 * decides *when to ask*. The upgrader job verifies the signed manifest
 * and refuses an automatic request the policy, the infrastructure contract
 * or destructive migrations forbid (provisioning upgrader-assess.ts),
 * including one queued as a security fix for a release whose signed
 * manifest names no advisory — so a forged "security" flag cannot shorten
 * the soak period.
 *
 * Rules, in order (maintainer decisions on #696):
 *   1. nothing newer → none (there is no "notices off": security
 *      releases are always announced, #862);
 *   2. off the stable channel, or the policy only notifies → notify;
 *   3. major → notify (never automatic before 1.0);
 *   4. release information unreadable → blocked (fails loudly, no guess);
 *   5. changes the cloud setup → needs_cloud_shell (never automatic, even
 *      with `autoConverge` on: that choice is inert until the converge job
 *      runs these releases from Caelo, #819);
 *   6. destructive database changes → manual (never automatic);
 *   7. the kind is not switched on (security / patch / minor) → notify;
 *   8. no upgrader on this install → blocked;
 *   9. paused by the Owner or after a failure → wait;
 *  10. soak period not over (security releases: their own, shorter one) → wait;
 *  11. outside the maintenance window → wait until it opens;
 *  12. otherwise → install.
 */

import {
  inMaintenanceWindow,
  type StoredUpdatePolicy,
  type UpdateKind,
  updateKind,
} from "./platform-updates.js";

/** Why the scheduler queued an automatic install (`platform_update_requests.auto_basis`). */
export const AUTO_UPDATE_BASES = ["security", "patch", "minor"] as const;
export type AutoUpdateBasis = (typeof AUTO_UPDATE_BASES)[number];

/** What the scheduler last did (`platform_update_scheduler.last_action`). */
export const AUTO_UPDATE_ACTIONS = [
  "none",
  "notify",
  "wait",
  "install",
  "manual",
  "needs_cloud_shell",
  "blocked",
] as const;
export type AutoUpdateAction = (typeof AUTO_UPDATE_ACTIONS)[number];

/** The Owner's update emails (`platform_update_notifications.kind`). */
export const UPDATE_NOTIFICATION_KINDS = [
  "available",
  "scheduled",
  "installed",
  "failed",
  "needs_cloud_shell",
] as const;
export type UpdateNotificationKind = (typeof UPDATE_NOTIFICATION_KINDS)[number];

/**
 * Whether a release counts as a security fix: the signed manifest says so
 * AND names at least one published GitHub Security Advisory (#696 decision
 * 2). The release workflow refuses `security: true` without one; this is
 * the second line.
 */
export function isSecurityRelease(manifest: {
  readonly security: boolean;
  readonly advisories: readonly string[];
}): boolean {
  return manifest.security && manifest.advisories.length > 0;
}

/** What the scheduler knows about the newest release from its manifest. */
export interface ReleaseFacts {
  /** {@link isSecurityRelease} of the manifest. */
  readonly security: boolean;
  readonly advisories: readonly string[];
  /** The release, or one it skips, carries destructive (contract) migrations. */
  readonly contractMigrations: boolean;
  /**
   * The release raises the infrastructure contract over the installed one.
   * null: not known here (the installed release has no manifest, or the
   * install has no separate cloud setup) — the upgrader checks it against
   * the install's own state before it changes anything.
   */
  readonly infraChange: boolean | null;
}

/** Everything {@link decideAutoUpdate} looks at. */
export interface AutoUpdateInput {
  readonly policy: StoredUpdatePolicy;
  readonly installedVersion: string;
  /** The newest release the release check found, or null. */
  readonly release: { readonly version: string; readonly publishedAt: string | null } | null;
  /** The release's facts, or why they could not be read. */
  readonly facts: ReleaseFacts | { readonly unavailable: string };
  /** This install has an upgrader the admin can hand a request to. */
  readonly upgraderAvailable: boolean;
  /** Why it has none right now, in plain words (null: none set up at all). */
  readonly upgraderProblem?: string | null;
  readonly now: Date;
}

/** What the scheduler does with the newest release now. */
export type AutoUpdateDecision =
  | { readonly action: "none"; readonly reason: string }
  | {
      readonly action: "notify" | "manual" | "needs_cloud_shell" | "blocked";
      readonly version: string;
      readonly kind: UpdateKind;
      readonly reason: string;
    }
  | {
      readonly action: "wait";
      readonly version: string;
      readonly kind: UpdateKind;
      readonly basis: AutoUpdateBasis;
      readonly reason: string;
      /** When it becomes installable; null = until the Owner resumes. */
      readonly until: Date | null;
      /** Waiting because automatic installs are paused (not soak/window). */
      readonly paused: boolean;
    }
  | {
      readonly action: "install";
      readonly version: string;
      readonly kind: UpdateKind;
      readonly basis: AutoUpdateBasis;
      readonly reason: string;
    };

/** Whether automatic installs are paused at `now` (an Owner pause may have ended). */
export function isPausedAt(
  policy: Pick<StoredUpdatePolicy, "paused" | "pausedUntil">,
  now: Date,
): boolean {
  if (!policy.paused) return false;
  return policy.pausedUntil === null || new Date(policy.pausedUntil).getTime() > now.getTime();
}

/**
 * The first minute at or after `from` inside the maintenance window, or
 * null when it does not open within two days (cannot happen for a valid
 * window; null keeps the caller honest instead of guessing).
 */
export function nextWindowOpening(
  policy: Pick<StoredUpdatePolicy, "windowStart" | "windowEnd" | "windowTimezone">,
  from: Date,
): Date | null {
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let m = 0; m <= 2 * 24 * 60; m++) {
    const at = new Date(start.getTime() + m * 60_000);
    if (inMaintenanceWindow(policy, at)) return at;
  }
  return null;
}

const KIND_WORDS: Record<UpdateKind, string> = {
  major: "major release",
  minor: "minor release",
  patch: "patch release",
};

const BASIS_WORDS: Record<AutoUpdateBasis, string> = {
  security: "security fix",
  patch: "patch release",
  minor: "minor release",
};

/** `v0.11.0` channel by its pre-release tag (`0.11.0-rc.1` → rc). */
function isStable(version: string): boolean {
  return !version.includes("-");
}

const hours = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;

/** Decide what the scheduler does now. See the file comment for the rules. */
export function decideAutoUpdate(input: AutoUpdateInput): AutoUpdateDecision {
  const { policy, release, now } = input;
  if (!release) {
    return { action: "none", reason: "The release check has not found a Caelo release yet." };
  }
  const kind = updateKind(input.installedVersion, release.version);
  if (kind === null) {
    return { action: "none", reason: `v${input.installedVersion} is the newest release.` };
  }
  const v = release.version;
  const base = { version: v, kind } as const;
  if (!isStable(v)) {
    return {
      action: "notify",
      ...base,
      reason: `v${v} is a pre-release; only stable releases install automatically.`,
    };
  }
  if (policy.mode === "notify") {
    return {
      action: "notify",
      ...base,
      reason: `v${v} is available. The update policy only notifies; the Owner installs it.`,
    };
  }
  if (kind === "major") {
    return {
      action: "notify",
      ...base,
      reason: `v${v} is a major release; major releases never install automatically before Caelo 1.0.`,
    };
  }
  if ("unavailable" in input.facts) {
    return {
      action: "blocked",
      ...base,
      reason: `The release information of v${v} could not be read (${input.facts.unavailable}), so it is not installed automatically. The next check tries again; the Owner can install it from Settings → Updates.`,
    };
  }
  const facts = input.facts;
  if (facts.infraChange === true) {
    // FIXME(issue #819): once the converge job runs these releases from
    // Caelo, `policy.autoConverge` decides here like autoPatch does below.
    // Until then the Owner's "install automatically" choice is stored but
    // has no effect, and the reason says so.
    const ownerChoice = policy.autoConverge
      ? " Your setting to install these automatically takes effect once Caelo can run them itself."
      : "";
    return {
      action: "needs_cloud_shell",
      ...base,
      reason: `v${v} changes this install's cloud setup, which the admin may not do. It is never installed automatically: the Owner runs it once with their own account in Cloud Shell.${ownerChoice}`,
    };
  }
  if (facts.contractMigrations) {
    return {
      action: "manual",
      ...base,
      reason: `v${v} makes database changes the previous release cannot run on, so it never installs automatically. The Owner installs it from Settings → Updates.`,
    };
  }
  const basis: AutoUpdateBasis | null =
    facts.security && policy.autoSecurity
      ? "security"
      : kind === "patch" && policy.autoPatch
        ? "patch"
        : kind === "minor" && policy.autoMinor
          ? "minor"
          : null;
  if (basis === null) {
    const what = facts.security ? `security fix (${KIND_WORDS[kind]})` : KIND_WORDS[kind];
    return {
      action: "notify",
      ...base,
      reason: `v${v} is a ${what}; the update policy does not install those automatically. The Owner installs it.`,
    };
  }
  if (!input.upgraderAvailable) {
    return {
      action: "blocked",
      ...base,
      reason: input.upgraderProblem
        ? `v${v} could install automatically, but the upgrader cannot take it now: ${input.upgraderProblem}`
        : `v${v} could install automatically, but this install has no upgrader the admin can start. Run the upgrade command from Settings → Updates once; it sets the upgrader up.`,
    };
  }
  const auto = { ...base, basis } as const;
  if (isPausedAt(policy, now)) {
    const until = policy.pausedUntil === null ? null : new Date(policy.pausedUntil);
    const who = policy.pausedByOwner ? "by the Owner" : "after a failed automatic install";
    return {
      action: "wait",
      ...auto,
      until,
      paused: true,
      reason: `Automatic installs are paused ${who}${until ? ` until ${until.toISOString()}` : " until the Owner resumes them"}${policy.pausedReason ? ` (${policy.pausedReason})` : ""}.`,
    };
  }
  if (release.publishedAt === null) {
    return {
      action: "blocked",
      ...base,
      reason: `The publish date of v${v} is not known, so its soak period cannot be counted. The next release check fills it in.`,
    };
  }
  const soak = basis === "security" ? policy.securitySoakHours : policy.soakHours;
  const ready = new Date(new Date(release.publishedAt).getTime() + soak * 3_600_000);
  if (ready.getTime() > now.getTime()) {
    const opening = inMaintenanceWindow(policy, ready) ? ready : nextWindowOpening(policy, ready);
    return {
      action: "wait",
      ...auto,
      until: opening,
      paused: false,
      reason: `v${v} (${BASIS_WORDS[basis]}) installs automatically once it has been out for ${hours(soak)}${opening && opening.getTime() !== ready.getTime() ? " and the maintenance window is open" : ""}.`,
    };
  }
  if (!inMaintenanceWindow(policy, now)) {
    return {
      action: "wait",
      ...auto,
      until: nextWindowOpening(policy, now),
      paused: false,
      reason: `v${v} (${BASIS_WORDS[basis]}) installs automatically when the maintenance window opens (${policy.windowStart}–${policy.windowEnd} ${policy.windowTimezone}).`,
    };
  }
  return {
    action: "install",
    ...auto,
    reason: `v${v} (${BASIS_WORDS[basis]}) installs automatically: the update policy allows it, its ${hours(soak)} soak period is over${policy.windowStart ? " and the maintenance window is open" : ""}.`,
  };
}
