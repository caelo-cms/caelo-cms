// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D6 — pure state logic for the /edit toolbar's Publish-live
 * control, extracted from StageDeployButton.svelte so the silent-no-op
 * class is pinned by unit tests (same tier as #267's regression test).
 *
 * The run #10 failure: no staging build had ever succeeded (the stage
 * itself was blocked by D4), so "Publish live" rendered disabled with
 * ONLY a hover tooltip explaining why — a click (human or scripted)
 * produced zero events and zero feedback. And when the button IS
 * enabled, a failed promote surfaced only through the layout toast,
 * which dedups identical consecutive results (#267's class), so a
 * retried identical failure showed nothing at all.
 *
 * Two rules fall out:
 *  1. a disabled Publish control must say WHY in visible text, not
 *     only in a tooltip (`visibleReason`);
 *  2. failures must land in a persistent inline alert next to the
 *     button (`formResultError` feeds it), immune to toast dedup.
 */

export interface PublishButtonState {
  readonly disabled: boolean;
  /**
   * Rendered as visible text next to the button when non-null. Only
   * set for states a click can't fix (nothing staged yet) — the
   * "live already matches staging" state is null here because the
   * green sync indicator already communicates it visibly.
   */
  readonly visibleReason: string | null;
  /** Hover tooltip (title attribute) — always set. */
  readonly tooltip: string;
}

/**
 * @param args.busy a Stage or Publish request is in flight.
 * @param args.hasStagedBuild a succeeded staging deploy exists to copy.
 * @param args.productionMatchesStaging null = unknown (no production
 *   deploy yet, or nothing staged to compare against).
 */
export function publishButtonState(args: {
  busy: boolean;
  hasStagedBuild: boolean;
  productionMatchesStaging: boolean | null;
  /** #553 — the quality gate of the staged build; null while unknown (the
   *  server enforces the gate regardless, so unknown never blocks here). */
  qualityGate?: QualityGateView | null;
}): PublishButtonState {
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
  const gate = args.qualityGate;
  if (gate && !gate.open) {
    const reason = qualityBlockReason(gate);
    return { disabled: true, visibleReason: reason, tooltip: gate.message || reason };
  }
  return {
    disabled: args.busy,
    visibleReason: null,
    tooltip: "Publish the latest staging build live (atomic, no rebuild)",
  };
}

/** The slice of the quality gate the toolbar needs. */
export interface QualityGateView {
  readonly open: boolean;
  readonly state: string;
  readonly message: string;
  readonly openProblemCount: number;
}

/**
 * #553 — the short visible reason a blocked Publish shows; the full
 * message (with the next step) is the tooltip.
 */
export function qualityBlockReason(gate: QualityGateView): string {
  switch (gate.state) {
    case "running":
      return "Quality check running — Publish live unlocks when it passes.";
    case "problems":
      return `Blocked by ${gate.openProblemCount} quality problem(s) — fix them and Stage again, or accept them in the chat.`;
    case "errored":
      return "Quality check failed — retry it, or publish anyway with a reason.";
    case "missing":
      return "The staged build has not been quality-checked yet — run the check.";
    default:
      return gate.message || "Publish live is blocked by the quality check.";
  }
}

/**
 * Map a SvelteKit enhanced-form `ActionResult` to the message the
 * inline alert should show — null when the action succeeded. Failures
 * NEVER map to null: an action that failed without a reason still gets
 * loud text pointing at the server logs (CLAUDE.md §2).
 */
export function formResultError(result: {
  type: string;
  data?: Record<string, unknown> | undefined;
  error?: unknown;
}): string | null {
  if (result.type === "failure") {
    const message = result.data?.error;
    return typeof message === "string" && message.length > 0
      ? message
      : "The server rejected the action and sent no reason. Check the server logs.";
  }
  if (result.type === "error") {
    return `Request crashed: ${
      result.error instanceof Error ? result.error.message : String(result.error)
    }`;
  }
  return null;
}
