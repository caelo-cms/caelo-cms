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

import { isParityRefusal } from "@caelo-cms/shared";

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
  /**
   * #1207 — the button is closed only because the last Stage failed, so
   * the staged build is older than the changes it was meant to carry.
   * That build itself passed its checks, so the Live menu still offers to
   * publish it as an explicit choice.
   */
  readonly overridable: boolean;
}

/**
 * @param args.busy a Stage or Publish request is in flight.
 * @param args.stageFailure why the newest Stage failed, or null when it
 *   did not (a failed staging build, or a Stage refused in this view).
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
  stageFailure?: string | null;
}): PublishButtonState {
  const state = readyState(args);
  if (!args.stageFailure || !args.hasStagedBuild) return state;
  const reason = "The last Stage failed, so staging does not have the newest changes. Fix it and Stage again.";
  return {
    disabled: true,
    visibleReason: reason,
    tooltip: `${reason} (${args.stageFailure})`,
    overridable: !state.disabled,
  };
}

/** The Publish live state from the staged build alone, before a failed Stage closes it. */
function readyState(args: {
  busy: boolean;
  hasStagedBuild: boolean;
  productionMatchesStaging: boolean | null;
  qualityGate?: QualityGateView | null;
}): PublishButtonState {
  if (!args.hasStagedBuild) {
    const reason = "Nothing staged yet — run Stage first; Publish live copies the staged build.";
    return { disabled: true, visibleReason: reason, tooltip: reason, overridable: false };
  }
  if (args.productionMatchesStaging === true) {
    return {
      disabled: true,
      visibleReason: null,
      tooltip: "Live already matches the current staging build — nothing to publish",
      overridable: false,
    };
  }
  const gate = args.qualityGate;
  if (gate && !gate.open) {
    const reason = qualityBlockReason(gate);
    return {
      disabled: true,
      visibleReason: reason,
      tooltip: gate.message || reason,
      overridable: false,
    };
  }
  return {
    disabled: args.busy,
    visibleReason: null,
    tooltip: "Publish the latest staging build live (atomic, no rebuild)",
    overridable: false,
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

/**
 * Which shape the Live edit toolbar takes:
 *  - `published`: the chat was published; nothing to do here.
 *  - `fresh`: no pending edits and nothing was ever staged.
 *  - `promote-only`: no pending edits, but a staged build exists (or this
 *    chat staged before): Publish live, plus Stage again.
 *  - `pending`: the chat has edits; Stage… opens the Stage dialog.
 */
export type StageToolbarMode = "published" | "fresh" | "promote-only" | "pending";

/** Pick the toolbar shape from the chat's and the site's deploy state. */
export function stageToolbarMode(args: {
  sessionPublished: boolean;
  branchChangeCount: number;
  hasStagedBuild: boolean;
  sessionLastStagedAt: string | null;
}): StageToolbarMode {
  if (args.sessionPublished) return "published";
  if (args.branchChangeCount > 0) return "pending";
  return args.hasStagedBuild || args.sessionLastStagedAt !== null ? "promote-only" : "fresh";
}

/**
 * The list key of one not-yet-staged entry. The same id appears under
 * several kinds in one group: a new page has a `page` entry and a
 * `pageLayout` entry (its placements), both keyed by the page id, so a key
 * of the id alone repeats and Svelte refuses to render the Staging menu.
 */
export function pendingEntryKey(entry: { kind: string; entityId: string }): string {
  return `${entry.kind}:${entry.entityId}`;
}

/**
 * #835 — whether the toolbar offers "Stage again" (rebuild staging from
 * main without pending edits). Always in the promote-only shape, whatever
 * the quality gate says: a Publish live refused by the parity guard, a
 * Caelo upgrade or fixes written live all need a fresh Stage,
 * and without pending edits this button is the operator's only way to
 * get one. With pending edits, Stage… covers it.
 */
export function offersStageAgain(mode: StageToolbarMode): boolean {
  return mode === "promote-only";
}

/**
 * #835 — the short, untruncated next step shown under a failed Publish
 * live. The inline error itself is truncated to fit the toolbar, so the
 * pointer at "Stage again" at the end of a parity refusal would be cut
 * off. Null for any other failure (its own text says what to do).
 */
export function publishErrorNextStep(message: string | null): string | null {
  if (message === null || !isParityRefusal(message)) return null;
  return "Use Stage again to rebuild staging, check it, then Publish live.";
}

/** How the toolbar's Staging button looks: its colour family. */
export type StagingTone = "neutral" | "pending" | "busy" | "ok" | "problem";

/** The Staging button's visible label, tone and tooltip. */
export interface StagingMenuState {
  readonly label: string;
  readonly tone: StagingTone;
  readonly tooltip: string;
}

/**
 * The Staging button of the toolbar: one label that says where staging
 * stands, so a closed Publish live always has its reason on screen (run #10
 * D6) without a sentence in the toolbar. The details and the actions sit
 * in the button's menu.
 */
export function stagingMenuState(args: {
  mode: StageToolbarMode;
  busy: boolean;
  hasStagedBuild: boolean;
  branchChangeCount: number;
  qualityGate: QualityGateView | null;
  /** Why the newest Stage failed, or null (see {@link publishButtonState}). */
  stageFailure?: string | null;
}): StagingMenuState {
  if (args.busy) {
    return { label: "Staging…", tone: "busy", tooltip: "Building staging and checking it" };
  }
  if (args.mode === "published") {
    return { label: "Chat published", tone: "neutral", tooltip: "This chat's work is live" };
  }
  if (args.stageFailure) {
    return { label: "Stage failed", tone: "problem", tooltip: args.stageFailure };
  }
  if (args.mode === "pending") {
    const n = args.branchChangeCount;
    return {
      label: "Staging",
      tone: "pending",
      tooltip: `${n} ${n === 1 ? "change" : "changes"} in this chat not staged yet`,
    };
  }
  if (!args.hasStagedBuild) {
    return {
      label: "Not staged",
      tone: "neutral",
      tooltip: "Nothing staged yet — Stage builds staging and checks it before Publish live",
    };
  }
  const gate = args.qualityGate;
  if (gate && !gate.open) {
    const tooltip = qualityBlockReason(gate);
    switch (gate.state) {
      case "running":
        return { label: "Checking…", tone: "busy", tooltip };
      case "problems": {
        const n = gate.openProblemCount;
        return { label: `${n} ${n === 1 ? "problem" : "problems"}`, tone: "problem", tooltip };
      }
      case "errored":
        return { label: "Check failed", tone: "problem", tooltip };
      default:
        return { label: "Not checked", tone: "pending", tooltip };
    }
  }
  return { label: "Staged", tone: "ok", tooltip: "Staging is built and checked" };
}
