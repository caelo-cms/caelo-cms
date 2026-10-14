// SPDX-License-Identifier: MPL-2.0

/**
 * Plain-language labels for Settings → Updates (#696): what each phase of
 * an upgrader run and each end state means to an Owner who has never heard
 * of a migration or a revision.
 */

import type { PlatformUpdatePhase, PlatformUpdateStatusValue } from "@caelo-cms/shared";

/** The timeline's steps, in order (rollback only shows when it happened). */
export const PHASE_LABELS: Readonly<Record<PlatformUpdatePhase, string>> = {
  queued: "Waiting to start",
  start: "Started",
  verify: "Checking the release is genuine",
  assess: "Checking it fits this site",
  backup: "Backing up your database",
  "health-baseline": "Making sure the site can be tested",
  migrations: "Updating the database",
  roll: "Switching to the new version",
  health: "Testing the new version",
  rollback: "Going back to the previous version",
  record: "Recording the new version",
  "self-update": "Updating the updater",
  finish: "Finished",
};

/** Status badge text + tone. */
export const STATUS_DISPLAY: Readonly<
  Record<
    PlatformUpdateStatusValue,
    { readonly label: string; readonly tone: "secondary" | "success" | "warning" | "destructive" }
  >
> = {
  pending: { label: "Waiting to start", tone: "secondary" },
  running: { label: "Installing", tone: "secondary" },
  succeeded: { label: "Installed", tone: "success" },
  rolled_back: { label: "Rolled back", tone: "warning" },
  failed: { label: "Failed", tone: "destructive" },
  refused: { label: "Not installed", tone: "destructive" },
  needs_cloud_shell: { label: "Needs Cloud Shell", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "secondary" },
};

/**
 * The badge for `status` on this kind of install: a self-hosted install's
 * hand-run upgrade happens on its server, not in Cloud Shell (#696 Phase 4c).
 */
export function statusDisplay(
  status: PlatformUpdateStatusValue,
  selfHosted: boolean,
): (typeof STATUS_DISPLAY)[PlatformUpdateStatusValue] {
  if (status === "needs_cloud_shell" && selfHosted) {
    return { label: "Needs a manual upgrade", tone: "warning" };
  }
  return STATUS_DISPLAY[status];
}

/** Whether a request is still in flight (the page keeps polling). */
export function isActive(status: PlatformUpdateStatusValue): boolean {
  return status === "pending" || status === "running";
}

/**
 * How long ago the release check ran, in words: "just now", "40 min ago",
 * "3 h ago", "2 days ago". A time in the future (clock skew between the
 * database and this server) reads as "just now".
 */
export function checkedAgo(checkedAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * What the "Your version" card says about the release check. `up_to_date`
 * only when the last check actually reached GitHub — a check that never ran
 * or failed must not read as "Up to date".
 */
export type ReleaseCheckState =
  | { readonly kind: "never" }
  | { readonly kind: "failed"; readonly ago: string }
  | { readonly kind: "up_to_date" | "update_available"; readonly ago: string };

/** The release-check state for `platform_updates.status`'s fields at `now`. */
export function releaseCheckState(
  status: {
    readonly latestVersion: string | null;
    readonly upgradeAvailable: boolean;
    readonly checkedAt: string | null;
  },
  now: Date,
): ReleaseCheckState {
  if (status.checkedAt === null) return { kind: "never" };
  const ago = checkedAgo(status.checkedAt, now);
  if (status.latestVersion === null) return { kind: "failed", ago };
  return { kind: status.upgradeAvailable ? "update_available" : "up_to_date", ago };
}
