// SPDX-License-Identifier: MPL-2.0

/**
 * The words of the Owner's update emails (epic #696 Phase 5). Pure: the
 * scheduler tick stores subject + body on the outbox row
 * (`platform_update_notifications`) inside its transaction, and delivery
 * renders the HTML from the stored text afterwards — so what was decided
 * and what was mailed can never drift apart.
 *
 * The admin process does not know its own public URL outside a request
 * (installs reach it through IAP / a proxy under a name only the operator
 * set up), so the emails name the page by path instead of linking it.
 */

import type { UpdateNotificationKind } from "@caelo-cms/shared";
import { UPDATES_PATH } from "../ops/platform-updates.js";

/** What one email says. */
export interface UpdateNotificationText {
  readonly subject: string;
  readonly body: string;
}

/** The facts an update email is written from. */
export interface UpdateNotificationFacts {
  readonly kind: UpdateNotificationKind;
  readonly version: string;
  readonly installedVersion: string;
  /** Plain-words why, from the scheduler's decision or the upgrader's end. */
  readonly reason: string | null;
  /** For `scheduled`: when the install starts (null = now). */
  readonly at?: Date | null;
}

const WHERE = `Settings → Updates in your Caelo admin (${UPDATES_PATH})`;

function when(at: Date | null | undefined): string {
  if (!at) return "within the next few minutes";
  return `at about ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Subject + plain-text body for one update email. */
export function updateNotificationText(f: UpdateNotificationFacts): UpdateNotificationText {
  const v = `v${f.version}`;
  const why = f.reason ? `\n\n${f.reason}` : "";
  switch (f.kind) {
    case "available":
      return {
        subject: `Caelo ${v} is available`,
        body: `A new Caelo release, ${v}, is available. Your site runs v${f.installedVersion}.${why}\n\nRead what it changes and install it at ${WHERE}.`,
      };
    case "scheduled":
      return {
        subject: `Caelo ${v} will install automatically`,
        body: `Your update policy installs Caelo ${v} automatically ${when(f.at)}. Your site runs v${f.installedVersion}.${why}\n\nBefore it switches, Caelo checks the release is genuine and backs up your database; if the new version fails its health check, it goes back to v${f.installedVersion} on its own.\n\nTo stop it, pause automatic updates at ${WHERE}.`,
      };
    case "installed":
      return {
        subject: `Caelo ${v} was installed`,
        body: `Caelo ${v} was installed automatically and passed its health check. Your site ran v${f.installedVersion} before.${why}\n\nThe step-by-step log is at ${WHERE}.`,
      };
    case "failed":
      return {
        subject: `Automatic Caelo update to ${v} did not complete`,
        body: `The automatic install of Caelo ${v} did not complete.${why}\n\nThe log and the next step are at ${WHERE}.`,
      };
    case "needs_cloud_shell":
      return {
        subject: `Caelo ${v} needs you to install it in Cloud Shell`,
        body: `Caelo ${v} changes your install's cloud setup, which the admin is not allowed to do, so it is not installed automatically.${why}\n\n${WHERE} explains what changes and has a button that opens Cloud Shell with the exact command for this release.`,
      };
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The stored plain-text body as minimal HTML (one paragraph per blank-line block). */
export function updateNotificationHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}
