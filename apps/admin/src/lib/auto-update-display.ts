// SPDX-License-Identifier: MPL-2.0

/**
 * Plain-language wording for Settings → Updates → Automatic updates (#696
 * Phase 5): the Owner's policy, its pause, what the scheduler last decided
 * and how each update email went — for an Owner who thinks in "my site
 * updates itself at night", not in soak periods and triggers.
 */

import type { AutoUpdateAction, StoredUpdatePolicy } from "@caelo-cms/shared";

const hours = (n: number) => (n === 0 ? "no wait" : `${n} hour${n === 1 ? "" : "s"}`);

/** The policy as a few short sentences. */
export function autoUpdateSummary(p: StoredUpdatePolicy): string[] {
  if (p.mode === "off") return ["You are not told about new Caelo releases."];
  if (p.mode === "notify") {
    return ["You are told about new Caelo releases and install them yourself."];
  }
  const kinds = [
    p.autoSecurity && "security fixes",
    p.autoPatch && "patch releases",
    p.autoMinor && "minor releases",
  ].filter((k): k is string => typeof k === "string");
  const lines = [
    kinds.length > 0
      ? `Installed automatically: ${kinds.join(", ")}. Everything else you install yourself.`
      : "Automatic installs are on, but no kind of release is chosen yet, so you install everything yourself.",
    p.windowStart
      ? `Only between ${p.windowStart} and ${p.windowEnd} (${p.windowTimezone}).`
      : "At any time of day.",
    `A release waits ${hours(p.soakHours)} after it comes out${p.autoSecurity ? `; a security fix ${hours(p.securitySoakHours)}` : ""}.`,
  ];
  return lines;
}

/** Title + detail of the pause banner, or null when not paused. */
export function pauseSummary(
  p: StoredUpdatePolicy,
  now: Date = new Date(),
): { readonly title: string; readonly detail: string } | null {
  if (!p.paused) return null;
  if (p.pausedUntil !== null && Date.parse(p.pausedUntil) <= now.getTime()) {
    return {
      title: "Pause ending",
      detail: "Your pause has ended; automatic updates resume at the next check.",
    };
  }
  const until = p.pausedUntil
    ? `until ${p.pausedUntil.slice(0, 16).replace("T", " ")} UTC`
    : "until you resume them";
  if (p.pausedByOwner) {
    return {
      title: `Automatic updates paused ${until}`,
      detail: p.pausedReason ?? "Paused by you.",
    };
  }
  return {
    title: "Automatic updates paused after a failed install",
    detail: `${p.pausedReason ?? "An automatic install did not complete."} Look at the update below, then resume automatic updates when you are ready.`,
  };
}

/** What the scheduler's last decision means. */
export const SCHEDULER_ACTION_LABELS: Readonly<Record<AutoUpdateAction, string>> = {
  none: "nothing to install",
  notify: "you install it yourself",
  wait: "waiting",
  install: "installing automatically",
  manual: "needs you to install it",
  needs_cloud_shell: "needs Cloud Shell",
  blocked: "cannot install it automatically",
};

/** How an update email's delivery went (badge text + tone). */
export const DELIVERY_DISPLAY: Readonly<
  Record<
    "pending" | "sending" | "sent" | "failed" | "no_transport" | "no_recipients",
    { readonly label: string; readonly tone: "secondary" | "success" | "warning" | "destructive" }
  >
> = {
  pending: { label: "Sending soon", tone: "secondary" },
  sending: { label: "Sending", tone: "secondary" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Not delivered", tone: "destructive" },
  no_transport: { label: "Not sent: no email set up", tone: "warning" },
  no_recipients: { label: "Not sent: no Owner email", tone: "warning" },
};
