// SPDX-License-Identifier: MPL-2.0
/**
 * @param args.busy a Stage or Publish request is in flight.
 * @param args.hasStagedBuild a succeeded staging deploy exists to copy.
 * @param args.productionMatchesStaging null = unknown (no production
 *   deploy yet, or nothing staged to compare against).
 */
export function publishButtonState(args) {
    if (!args.hasStagedBuild) {
        const reason = "Nothing staged yet — run Stage first; Publish live copies the staged build.";
        return { disabled: true, visibleReason: reason, tooltip: reason };
    }
    if (args.productionMatchesStaging === true) {
        return {
            disabled: true,
            visibleReason: null,
            tooltip: "Live already matches the current staging build — nothing to publish",
        };
    }
    return {
        disabled: args.busy,
        visibleReason: null,
        tooltip: "Publish the latest staging build live (atomic, no rebuild)",
    };
}
/**
 * Map a SvelteKit enhanced-form `ActionResult` to the message the
 * inline alert should show — null when the action succeeded. Failures
 * NEVER map to null: an action that failed without a reason still gets
 * loud text pointing at the server logs (CLAUDE.md §2).
 */
export function formResultError(result) {
    if (result.type === "failure") {
        const message = result.data?.error;
        return typeof message === "string" && message.length > 0
            ? message
            : "The server rejected the action and sent no reason. Check the server logs.";
    }
    if (result.type === "error") {
        return `Request crashed: ${result.error instanceof Error ? result.error.message : String(result.error)}`;
    }
    return null;
}
