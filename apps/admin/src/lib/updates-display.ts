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

/** Whether a request is still in flight (the page keeps polling). */
export function isActive(status: PlatformUpdateStatusValue): boolean {
  return status === "pending" || status === "running";
}
