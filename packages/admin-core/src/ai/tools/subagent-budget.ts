// SPDX-License-Identifier: MPL-2.0

/**
 * issue #304 — pure budget math for subagent fan-out.
 *
 * Runs #14/#15 (searchviu replay) measured every `spawn_subagents` child
 * building a page batch at **90–167M µ¢ ($0.90–$1.67)** of real spend,
 * against the old hardcoded 50M µ¢ ($0.50) per-child default. 100% of the
 * children errored at the cap, the orchestrator fell back to SERIAL
 * building in the parent session, and the parent's history grew
 * monstrously (fan-out IS the context diet — a fresh child context costs
 * ~100K input tokens per call where the serial parent pays its whole
 * accumulated history on every call).
 *
 * The fix: caps derive from the budget the operator actually approved
 * (the #297 armed run ceiling), and a child that approaches its cap
 * finishes its current work item and submits a PARTIAL result instead of
 * erroring — spent money buys landed pages, never a discarded transcript.
 *
 * Everything in this module is side-effect free (no DB, no env, no I/O)
 * so the cap formula and the partial-result classification are
 * unit-testable in isolation. Env fallbacks are parsed by the caller
 * (spawn-subagent.ts) and passed in.
 */

import { validateSubagentResultValue } from "@caelo-cms/shared";

/**
 * Fraction of the REMAINING run budget the children of one
 * `spawn_subagents` call may collectively consume. The held-back 10%
 * keeps the parent orchestrator's own turns (result digestion,
 * verification, reporting) from being starved to the #297 trip line by
 * its own children.
 */
export const CHILD_BUDGET_SHARE = 0.9;

/**
 * Floor for a derived per-child cap, in microcents. $1.00 sits just above
 * the bottom of the observed 90–167M µ¢ per-child band (runs #14/#15) —
 * a cap below what one child empirically NEEDS guarantees a cap error and
 * re-creates the serial fallback #304 kills. When even the floor doesn't
 * fit into the remaining budget, the remaining budget itself wins (a
 * child may never be promised more than the run has left).
 */
export const MIN_CHILD_CAP_MICROCENTS = 100_000_000;

/**
 * Percent of its cost cap at which a child stops STARTING new work items:
 * the chat-runner injects a wrap-up notice, the child finishes the item
 * in progress and submits a partial result. Integer percent so the
 * boundary check is exact integer math (`spent × 100 ≥ cap × 85`).
 * 85% leaves ~15% headroom for finishing the current page + the
 * submit_result turn before the 100% hard abort in streaming.ts fires.
 */
export const CHILD_CAP_WRAPUP_PERCENT = 85;

/**
 * Hard ceiling on dispatch waves inside ONE `spawn_subagents` call
 * (wave 0 + up to 4 remainder re-dispatches). The real bounds are the
 * per-remainder no-progress guard and the between-waves run-budget
 * re-check; this is the belt on top of those braces.
 */
export const SUBAGENT_MAX_WAVES = 5;

/**
 * A remainder that completes ZERO new pages this many waves in a row
 * stops loudly instead of being re-dispatched again (issue #304 —
 * bounded retries; a child that cannot advance will not advance on the
 * third identical attempt either).
 */
export const MAX_ZERO_PROGRESS_WAVES = 2;

/** Where a derived cap came from — surfaced in the batch roll-up text. */
export type ChildCapSource = "run-budget" | "fallback";

/** The per-wave caps `spawn_subagents` runs a wave under. */
export interface DerivedChildCaps {
  /** Cap applied to each child that did not set an explicit cap. */
  perChildCapMicrocents: number;
  /** In-flight abort line for the wave as a whole (runSubagentBatch). */
  batchCapMicrocents: number;
  source: ChildCapSource;
}

/**
 * issue #304 — derive the per-child and per-wave cost caps.
 *
 * With an ARMED run ceiling (#297) and `remaining = ceiling − spent`:
 *
 *   child_cap = clamp(remaining × CHILD_BUDGET_SHARE / planned_children,
 *                     MIN_CHILD_CAP_MICROCENTS, remaining)
 *   batch_cap = remaining × CHILD_BUDGET_SHARE
 *
 * Worked example (run #15 scale): estimate high $1.40 × safety 3 arms a
 * $4.20 ceiling; $0.20 already spent → remaining 400M µ¢. A 3-child wave
 * gets 400M × 0.9 / 3 = 120M µ¢ per child — inside the observed
 * 90–167M µ¢ band, where the old 50M constant failed every child.
 *
 * The MIN clamp keeps many-children waves from starving each child below
 * what one page batch empirically costs (children then wrap up partial
 * and the remainder rolls into the next wave); the `remaining` clamp
 * keeps a single child from being promised more than the whole run has
 * left. `remaining ≤ 0` yields zero caps — the caller must not dispatch
 * (it surfaces the #297 pause instead).
 *
 * With NO armed ceiling (ordinary chats — #297 guarantees import runs
 * always arm one), the env-tunable fallbacks passed by the caller apply
 * unchanged.
 */
export function deriveChildCaps(input: {
  /** `ceiling − spent` of the armed run budget; null = no ceiling armed. */
  remainingRunBudgetMicrocents: number | null;
  /** Children the caller is about to dispatch in this wave (≥ 1). */
  plannedChildren: number;
  /** Env fallback per-child cap (SUBAGENT_CHILD_CAP_MICROCENTS). */
  fallbackChildCapMicrocents: number;
  /** Env fallback batch cap (SUBAGENT_BATCH_CAP_MICROCENTS). */
  fallbackBatchCapMicrocents: number;
}): DerivedChildCaps {
  const children = Math.max(1, Math.floor(input.plannedChildren));
  const remaining = input.remainingRunBudgetMicrocents;
  if (remaining === null) {
    return {
      perChildCapMicrocents: input.fallbackChildCapMicrocents,
      batchCapMicrocents: input.fallbackBatchCapMicrocents,
      source: "fallback",
    };
  }
  if (remaining <= 0) {
    return { perChildCapMicrocents: 0, batchCapMicrocents: 0, source: "run-budget" };
  }
  const batchCapMicrocents = Math.floor(remaining * CHILD_BUDGET_SHARE);
  const rawPerChild = Math.floor(batchCapMicrocents / children);
  const perChildCapMicrocents = Math.min(
    Math.max(rawPerChild, MIN_CHILD_CAP_MICROCENTS),
    remaining,
  );
  return { perChildCapMicrocents, batchCapMicrocents, source: "run-budget" };
}

/**
 * True when a child's spend has crossed the wrap-up line
 * (≥ {@link CHILD_CAP_WRAPUP_PERCENT}% of its cap). Integer math so the
 * boundary is exact. A cap of 0 (run budget already exhausted) always
 * wraps up.
 */
export function shouldWrapUpAtCap(spentMicrocents: number, capMicrocents: number): boolean {
  return spentMicrocents * 100 >= capMicrocents * CHILD_CAP_WRAPUP_PERCENT;
}

/**
 * The wrap-up notice injected into a child's transcript when its spend
 * crosses the wrap-up line. System-origin user message: the child model
 * reads it as an instruction, the transcript shows it muted. The exact
 * skip marker ("not reached: cost cap") is what
 * {@link extractRebuildPartial} keys nothing on — the remainder is every
 * non-rebuilt page — but it makes the child's report unambiguous for the
 * operator and the parent AI alike.
 */
export function capWrapUpNoticeText(spentMicrocents: number, capMicrocents: number): string {
  const usd = (mc: number): string => `$${(mc / 1e8).toFixed(2)}`;
  return (
    `Cost checkpoint: you have used ~${usd(spentMicrocents)} of your ${usd(capMicrocents)} ` +
    `budget for this task (>=${CHILD_CAP_WRAPUP_PERCENT}%). Finish ONLY the work item you are ` +
    "currently on (e.g. the page you are editing) — do NOT start the next one. Then call " +
    "submit_result immediately. If your result shape is `rebuild`, report every page you did " +
    'not get to as {"status": "skipped", "notes": "not reached: cost cap"} so the orchestrator ' +
    "can re-dispatch exactly those. Work you have already completed is saved either way."
  );
}

/** One page reference inside a rebuild-shaped result. */
export interface SubagentPageRef {
  pageId?: string;
  slug?: string;
  notes?: string;
}

/** The partial-completion state extracted from a rebuild-shaped result. */
export interface SubagentPartialState {
  /** Pages the child reported `status: "rebuilt"` for — landed work. */
  completedPages: SubagentPageRef[];
  /** Pages the child did NOT rebuild (skipped or failed) — the remainder. */
  remainingPages: SubagentPageRef[];
}

/**
 * Split a `rebuild`-shaped result into completed vs remaining pages.
 * Returns null when the value is not a valid rebuild result (other
 * shapes — verdict/tree/freeform — have no page decomposition, so
 * partial re-dispatch does not apply to them).
 */
export function extractRebuildPartial(resultJson: unknown): SubagentPartialState | null {
  const validated = validateSubagentResultValue(resultJson, "rebuild");
  if (!validated.ok || validated.shape !== "rebuild") return null;
  const completedPages: SubagentPageRef[] = [];
  const remainingPages: SubagentPageRef[] = [];
  for (const page of validated.value.pages) {
    const ref: SubagentPageRef = {
      ...(page.pageId !== undefined ? { pageId: page.pageId } : {}),
      ...(page.slug !== undefined ? { slug: page.slug } : {}),
      ...(page.notes !== undefined ? { notes: page.notes } : {}),
    };
    if (page.status === "rebuilt") completedPages.push(ref);
    else remainingPages.push(ref);
  }
  return { completedPages, remainingPages };
}

/** How a submitted child result classifies for the batch orchestrator. */
export interface ChildCompletionClass {
  status: "completed" | "partial";
  /** Present only for `partial`. */
  partial?: SubagentPartialState;
}

/**
 * issue #304 — classify a child that DID submit a result. `partial` when
 * all three hold:
 *   1. spend crossed the wrap-up line (≥85% of the child's cap) — the
 *      child stopped for cost, not by choice;
 *   2. the result is rebuild-shaped — only that shape decomposes into
 *      per-page work the parent can re-dispatch;
 *   3. at least one page was NOT rebuilt — there IS a remainder.
 * Everything else stays `completed`: a cheap child that skipped pages
 * made an editorial call (its skip reasons go to the parent verbatim,
 * re-dispatching would just re-litigate them), and an expensive child
 * that finished everything simply finished.
 */
export function classifyChildCompletion(input: {
  costMicrocents: number;
  capMicrocents: number;
  resultJson: unknown;
}): ChildCompletionClass {
  if (!shouldWrapUpAtCap(input.costMicrocents, input.capMicrocents)) {
    return { status: "completed" };
  }
  const partial = extractRebuildPartial(input.resultJson);
  if (partial === null || partial.remainingPages.length === 0) {
    return { status: "completed" };
  }
  return { status: "partial", partial };
}

/** Render a page ref for a task brief / summary line. */
function pageRefLabel(ref: SubagentPageRef): string {
  return ref.slug ?? ref.pageId ?? "(unidentified page)";
}

/** Comma list of page refs; bounded so a huge batch can't bloat a brief. */
export function pageRefList(refs: readonly SubagentPageRef[], max = 40): string {
  const labels = refs.slice(0, max).map(pageRefLabel);
  const overflow = refs.length > max ? ` … and ${refs.length - max} more` : "";
  return labels.join(", ") + overflow;
}

/**
 * issue #304 — the continuation brief for re-dispatching a partial
 * child's remainder. Prefixed to the ORIGINAL task (which stays the
 * source of truth for ids, ground-truth fetch instructions, and the
 * return-shape contract — the child is fresh and has no memory of the
 * previous attempt) so the child skips landed pages instead of
 * re-spending on them.
 */
export function buildRemainderTask(input: {
  originalTask: string;
  completedPages: readonly SubagentPageRef[];
  remainingPages: readonly SubagentPageRef[];
  wave: number;
}): string {
  const done =
    input.completedPages.length > 0
      ? `Already completed in a previous pass (do NOT touch these again): ${pageRefList(input.completedPages)}.\n`
      : "";
  const remainingLines = input.remainingPages
    .slice(0, 40)
    .map((r) => `- ${pageRefLabel(r)}${r.notes ? ` (previous attempt noted: ${r.notes})` : ""}`)
    .join("\n");
  return (
    `CONTINUATION (pass ${input.wave + 1}) of a task a previous subagent could only partially ` +
    `finish before hitting its cost budget. ${done}` +
    `Work ONLY on these remaining pages:\n${remainingLines}\n` +
    "If a remaining page was previously skipped for a good editorial reason (see its note), " +
    "report it skipped again with the same reason instead of re-doing the analysis.\n\n" +
    `ORIGINAL TASK (for ids, ground truth, and field semantics):\n${input.originalTask}`
  );
}

/**
 * Merge pages completed in earlier waves into a remainder attempt's
 * rebuild result so the parent sees ONE full-coverage result per original
 * spec. Later entries win on slug/pageId collision (the latest attempt
 * has the freshest status for a page). Non-rebuild / non-object results
 * pass through untouched.
 */
export function mergeRebuildPages(
  earlierCompleted: readonly SubagentPageRef[],
  lastResultJson: unknown,
): unknown {
  if (earlierCompleted.length === 0) return lastResultJson;
  const last =
    typeof lastResultJson === "object" && lastResultJson !== null && !Array.isArray(lastResultJson)
      ? (lastResultJson as Record<string, unknown>)
      : null;
  const lastPages = Array.isArray(last?.pages) ? (last.pages as Record<string, unknown>[]) : null;
  if (last === null || lastPages === null) return lastResultJson;
  const keyOf = (p: { pageId?: unknown; slug?: unknown }): string =>
    String(p.slug ?? p.pageId ?? "");
  const lastKeys = new Set(lastPages.map(keyOf).filter((k) => k !== ""));
  const carried = earlierCompleted
    .filter((p) => !lastKeys.has(keyOf(p)))
    .map((p) => ({
      ...(p.pageId !== undefined ? { pageId: p.pageId } : {}),
      ...(p.slug !== undefined ? { slug: p.slug } : {}),
      status: "rebuilt" as const,
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
    }));
  return { ...last, pages: [...carried, ...lastPages] };
}
