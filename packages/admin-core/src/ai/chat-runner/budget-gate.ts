// SPDX-License-Identifier: MPL-2.0

/**
 * issue #297 — the LIVE cost gate for import/migration runs.
 *
 * #294 (issue #280) shipped the plumbing: an operator-confirmed ceiling on
 * `import_runs`, a spend roll-up (`imports.get_run_cost`), and the ADVISORY
 * `check_run_budget` tool the model was supposed to call between batches.
 * Run #15 proved advisory isn't enough — the ceiling was never armed and
 * a single 107-call session burned ~$19–92 against a $1.40 estimate.
 *
 * This module is the enforcement half, checked by the tool loop ONCE PER
 * ITERATION (i.e. before every provider call — the granularity issue #297
 * demands, since one turn can run 25 loops and grow 5× in per-call cost):
 *
 *   liveSpend = DB roll-up of every RECORDED ai_calls row for the run's
 *               session set (past turns + completed subagent children)
 *             + the in-memory usage accumulator of the CURRENT turn
 *               (recorded only at turn end, so the DB alone lags).
 *
 *   ≥ 80% of the ceiling → one warning (claimed atomically across parallel
 *     sessions via imports.record_budget_gate_event) lands in the chat as a
 *     system-origin status note AND in the run's import_run_events ledger.
 *   ≥ 100%              → the loop finishes nothing new: the in-flight
 *     iteration's tool results are already persisted, the turn ends with a
 *     clear pause message (real spend vs the approved estimate) and resumes
 *     only after the operator re-arms via set_migration_budget /
 *     imports.set_cost_ceiling (which clears the claims). No hard-kill, no
 *     silent overrun.
 *
 * Known approximation, documented on purpose: the current-turn increment
 * prices tokens at the runner's configured per-MTok rates (limits.ts), not
 * the ai_pricing table — the two reconcile at turn end when the ai_calls
 * row is written. A parent turn also cannot see a child's IN-FLIGHT spend;
 * the child's own loop runs this same gate, so the blind spot is bounded
 * by one child turn.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  type BudgetGateLevel,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  evaluateBudgetGate,
  formatMicrocentsAsMoney,
} from "../../ops/imports-cost.js";

/** Mirror of `imports.get_session_budget_state`'s non-null gate payload. */
export interface BudgetGateState {
  runId: string;
  ceilingMicrocents: number;
  ceilingCurrency: string;
  spentMicrocents: number;
  callCount: number;
  unpricedCallCount: number;
  estimateLowUsd: number | null;
  estimateHighUsd: number | null;
  warningEmitted: boolean;
  tripped: boolean;
}

/**
 * Resolve the budget gate for a chat session (orchestrator or subagent
 * child). `null` — the common case — means "no ceilinged import run
 * governs this session; skip the per-loop checks".
 */
export async function fetchBudgetGate(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  chatSessionId: string,
): Promise<BudgetGateState | null> {
  const r = await execute(registry, adapter, ctx, "imports.get_session_budget_state", {
    chatSessionId,
  });
  if (!r.ok) {
    // Minimal embeddings (fixture registries in loop unit tests) don't
    // register the imports ops at all — that's a structural "no gate",
    // not a failure worth a red log line.
    if (r.error.kind === "UnknownOperation") return null;
    // Pre-1.0 fail-loud: a broken gate read must be visible in logs, but it
    // must not brick every chat turn — the gate simply doesn't run this
    // iteration and the next iteration retries the read.
    console.error("[chat-runner] budget-gate state read failed", {
      chatSessionId,
      error: r.error,
    });
    return null;
  }
  return (r.value as { gate: BudgetGateState | null }).gate;
}

/** Evaluate live spend (DB roll-up + current-turn accumulator) vs ceiling. */
export function evaluateGateLevel(
  gate: BudgetGateState,
  currentTurnMicrocents: number,
): { level: BudgetGateLevel; liveSpentMicrocents: number } {
  const liveSpentMicrocents = gate.spentMicrocents + Math.max(0, currentTurnMicrocents);
  return {
    level: evaluateBudgetGate({
      spentMicrocents: liveSpentMicrocents,
      ceilingMicrocents: gate.ceilingMicrocents,
    }).level,
    liveSpentMicrocents,
  };
}

/** The `(N call(s) have no pricing …)` suffix when spend is understated. */
function unpricedSuffix(gate: BudgetGateState): string {
  return gate.unpricedCallCount > 0
    ? ` Note: ${gate.unpricedCallCount} AI call(s) have no pricing configured (/security/ai), so real spend is HIGHER than this figure.`
    : "";
}

/** One-shot 80% warning — persisted as a system-origin status note. */
export function budgetWarningText(gate: BudgetGateState, liveSpentMicrocents: number): string {
  const money = (mc: number): string => formatMicrocentsAsMoney(mc, gate.ceilingCurrency);
  const pct = Math.floor((liveSpentMicrocents / gate.ceilingMicrocents) * 100);
  return (
    `Budget notice: this import run has used ~${money(liveSpentMicrocents)} of its ` +
    `${money(gate.ceilingMicrocents)} cost ceiling (${pct}%). The run pauses automatically at ` +
    `the ceiling; to avoid the pause, the operator can raise the budget now ` +
    `(set_migration_budget).${unpricedSuffix(gate)}`
  );
}

/** The 100% pause message — real spend vs the approved estimate + how to resume. */
export function budgetTripText(gate: BudgetGateState, liveSpentMicrocents: number): string {
  const money = (mc: number): string => formatMicrocentsAsMoney(mc, gate.ceilingCurrency);
  const estimateLine =
    gate.estimateHighUsd !== null
      ? `The approved estimate was $${gate.estimateLowUsd ?? 0}–$${gate.estimateHighUsd} and the ceiling was armed at ${ESTIMATE_CEILING_SAFETY_FACTOR}× its high end; real spend has now reached that ceiling.`
      : "Real spend has reached the budget the operator set for this run.";
  return (
    `Cost ceiling reached — pausing this import run cleanly. Spent ~${money(liveSpentMicrocents)} ` +
    `of the ${money(gate.ceilingMicrocents)} budget. ${estimateLine} Nothing is lost: finished ` +
    `work is saved and the run resumes where it stopped. To continue, set a new ceiling ` +
    `(tell the AI a new amount — it records it with set_migration_budget — or use ` +
    `/security/import) and then say "continue". To stop here, ask for the run report ` +
    `instead.${unpricedSuffix(gate)}`
  );
}
