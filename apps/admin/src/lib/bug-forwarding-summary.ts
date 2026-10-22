// SPDX-License-Identifier: MPL-2.0

/**
 * The /settings/bugs page summary about the Caelo team (issue #902).
 *
 * Each report carries its own `forwarding_state`, so the summary is derived
 * from the states actually present rather than a fixed sentence: a fixed
 * "the Caelo team only sees these if you send them" contradicts every row
 * that says Queued or Sent once forwarding is on.
 */

/** Where a bug report went — mirrors `ai_bug_reports.forwarding_state`. */
export type BugForwardingState = "local_only" | "queued" | "sent" | "failed";

/**
 * The sentence asking the operator to export reports by hand, or `null` when
 * every report is already sent or on its way (nothing to export).
 *
 * @param states the `forwardingState` of every listed report.
 */
export function unsentReportsSummary(states: readonly BugForwardingState[]): string | null {
  // queued reports leave automatically; only local_only and failed ones
  // need the operator to send them.
  const unsent = states.filter((s) => s === "local_only" || s === "failed").length;
  if (unsent === 0) return null;
  const subject = unsent === 1 ? "1 report has" : `${unsent} reports have`;
  return `${subject} not reached the Caelo team. Export the list and send it to us, or paste it into a GitHub issue.`;
}
