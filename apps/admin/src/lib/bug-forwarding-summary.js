// SPDX-License-Identifier: MPL-2.0
/**
 * The sentence asking the operator to export reports by hand, or `null` when
 * every report is already sent or on its way (nothing to export).
 *
 * @param states the `forwardingState` of every listed report.
 */
export function unsentReportsSummary(states) {
    // queued reports leave automatically; only local_only and failed ones
    // need the operator to send them.
    const unsent = states.filter((s) => s === "local_only" || s === "failed").length;
    if (unsent === 0)
        return null;
    const subject = unsent === 1 ? "1 report has" : `${unsent} reports have`;
    return `${subject} not reached the Caelo team. Export the list and send it to us, or paste it into a GitHub issue.`;
}
