// SPDX-License-Identifier: MPL-2.0

/**
 * issue #280 — the migration cost gate's AI surface.
 *
 * `set_migration_budget` records the operator-confirmed money ceiling on a
 * run (imports.set_cost_ceiling). `check_run_budget` reads the live spend
 * roll-up (imports.get_run_cost) across the orchestrator + every subagent
 * session and phrases it as a pause-or-continue decision.
 *
 * The gate is ADVISORY: these tools never stop the run. The flow (Wave 3
 * site-migrate skill) decides when to call `check_run_budget` and how to
 * act on `overBudget` — this engine only supplies honest data.
 *
 * `set_migration_budget` is HUMAN-APPROVAL-GATED (CLAUDE.md §11.A). It used to
 * rely on the words "Do NOT invent a ceiling the operator never confirmed" in
 * its own description, and on 2026-07-27 that failed exactly as an
 * instruction-only guard eventually does: 39 seconds after the budget gate
 * warned at 86% of a $7.89 ceiling, the AI called this tool and raised the
 * ceiling to $100 on its own. The audit row reads `actor_kind = ai`, and the
 * operator learned about it afterwards.
 *
 * Raising a spend ceiling is the §11.A test case — "if the AI got this wrong,
 * can the user undo it with one tool call?" No: the money is gone by the time
 * anyone notices. So the AI proposes the number and the operator clicks. It
 * keeps `actorScope: ["human","ai","system"]` at the op, because the gate
 * belongs at the tool where the click happens, not at a scope that would also
 * lock out the Owner panel and the system path.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { formatMicrocentsAsMoney, roundsToZeroMicrocents } from "../../ops/imports-cost.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const setBudgetInput = z
  .object({
    runId: z.string().uuid(),
    // Reject a ceiling that rounds to 0µ¢ (see roundsToZeroMicrocents):
    // a sub-microcent "budget" stores as 0 and reads as over budget the
    // instant it's set, contradicting the confirmed-positive-ceiling intent.
    ceiling: z
      .number()
      .positive()
      .max(1_000_000)
      .refine((c) => !roundsToZeroMicrocents(c), {
        message:
          "budget too small — this amount rounds to 0 at microcent precision; confirm a larger ceiling with the operator (a fraction of a cent or more)",
      }),
    currency: z
      .string()
      .trim()
      .min(2)
      .max(8)
      .regex(/^[A-Za-z]+$/),
  })
  .strict();
type SetBudgetInput = z.infer<typeof setBudgetInput>;

export const setMigrationBudgetTool: ToolDefinitionWithHandler<SetBudgetInput> = {
  name: "set_migration_budget",
  description:
    "Propose the money ceiling for a migration run, in the currency the operator named. Approving an import proposal already arms a ceiling from the estimate's high end, so call this only when the operator names a DIFFERENT amount — or to RAISE the budget after the gate paused the run ('Cost ceiling reached'), which re-arms it so the run can continue. `ceiling` is the whole-run budget in major units (10 for €10), not per-page. " +
    "This is a TWO-STEP flow: you propose the amount, the operator clicks Approve on the card in the chat, and only then is the ceiling recorded. Do not claim the budget was applied, and do not carry on as if the higher ceiling were already in force. Never propose an amount the operator has not named — the click confirms their number, it does not authorise yours. Use `check_run_budget` to track spend against the ceiling.",
  // Always gated, in both directions. Lowering a ceiling is harmless, but a
  // predicate cannot tell the directions apart: `needsApproval` receives only
  // (input, ctx) — no adapter — so the current ceiling is not readable here.
  // Given the choice between an unconditional click and a guess, a money
  // figure gets the click.
  needsApproval: () => true,
  buildApprovalPreview: (input) => ({
    op: "set_migration_budget",
    runId: input.runId,
    proposedCeiling: input.ceiling,
    currency: input.currency.toUpperCase(),
  }),
  schema: setBudgetInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "ceiling", "currency"],
    properties: {
      runId: { type: "string", format: "uuid" },
      ceiling: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: 1000000,
        description: "Whole-run budget in major units the operator confirmed (10 = €10).",
      },
      currency: {
        type: "string",
        minLength: 2,
        maxLength: 8,
        description: "Letter currency code the operator named, e.g. EUR, USD, GBP.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.set_cost_ceiling",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `set_migration_budget failed: ${describeError(r.error)}` };
    }
    const v = r.value as { ceilingMicrocents: number; currency: string };
    return {
      ok: true,
      content: `Budget recorded: ${formatMicrocentsAsMoney(v.ceilingMicrocents, v.currency)} for this migration. Use check_run_budget before each rebuild batch to track spend against it.`,
    };
  },
};

const checkBudgetInput = z.object({ runId: z.string().uuid() }).strict();
type CheckBudgetInput = z.infer<typeof checkBudgetInput>;

interface RunCostResult {
  spentMicrocents: number;
  callCount: number;
  /** issue #297 — calls recorded at cost 0 because no ai_pricing row
   *  matched; spend is understated while this is >0. */
  unpricedCallCount: number;
  subagentSessionCount: number;
  ceilingMicrocents: number | null;
  ceilingCurrency: string | null;
  remainingMicrocents: number | null;
  overBudget: boolean;
  extrapolation: {
    spentSoFar: number;
    workDone: number;
    workTotal: number;
    extrapolatedTotal: number | null;
  };
  currencyConversionApplied: boolean;
  currencyNote: string | null;
}

export const checkRunBudgetTool: ToolDefinitionWithHandler<CheckBudgetInput> = {
  name: "check_run_budget",
  description:
    "Check the migration run's cumulative AI spend (orchestrator + all subagents) against the operator's confirmed budget, and get a progress-weighted estimate of the total cost to finish. This is a PAUSE-AND-ASK gate, NOT an auto-stop: call it BEFORE starting each rebuild batch. If spend has crossed the ceiling, FINISH the page currently in flight, then STOP dispatching new batches and ask the operator — show them what's done, what's spent, and the extrapolated cost to finish — to either raise the budget (set_migration_budget with a new amount) or stop here. Never silently keep spending past the ceiling, and never claim the migration is done while pages remain and the budget is blown. When no budget is set yet, it tells you to record one with set_migration_budget.",
  schema: checkBudgetInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: { runId: { type: "string", format: "uuid" } },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "imports.get_run_cost", input);
    if (!r.ok) {
      return { ok: false, content: `check_run_budget failed: ${describeError(r.error)}` };
    }
    const v = r.value as RunCostResult;
    const currency = v.ceilingCurrency ?? "USD";
    const money = (mc: number) => formatMicrocentsAsMoney(mc, currency);
    const { workDone, workTotal, extrapolatedTotal } = v.extrapolation;
    const spent = money(v.spentMicrocents);
    const progress = `${workDone}/${workTotal} pages rebuilt`;

    if (v.ceilingMicrocents === null) {
      // No ceiling recorded — the operator never confirmed a budget.
      const proj =
        extrapolatedTotal !== null
          ? ` At this pace the full run extrapolates to ~${money(extrapolatedTotal)}.`
          : "";
      return {
        ok: true,
        content: `No budget set for this migration. Spent so far: ${spent} across ${v.callCount} AI call(s) (orchestrator + ${v.subagentSessionCount} subagent session(s)); ${progress}.${proj} Propose a cost to the operator and record the amount they confirm with set_migration_budget.`,
      };
    }

    const ceiling = money(v.ceilingMicrocents);
    const unpricedNote =
      v.unpricedCallCount > 0
        ? ` WARNING: ${v.unpricedCallCount} AI call(s) recorded no cost because no ai_pricing row matches their model — real spend is HIGHER than shown; tell the operator to add the model at /security/ai.`
        : "";
    const noteSuffix = (v.currencyNote ? ` (${v.currencyNote})` : "") + unpricedNote;

    if (v.overBudget) {
      const moreLine =
        extrapolatedTotal !== null
          ? `~${money(Math.max(0, extrapolatedTotal - v.spentMicrocents))} more to finish (${money(extrapolatedTotal)} total)`
          : "the cost to finish can't be extrapolated yet (no pages rebuilt)";
      return {
        ok: true,
        content: `BUDGET REACHED — PAUSE. You budgeted ${ceiling}; spent ${spent}; ${progress}. ${moreLine}. Finish the page you're on, then STOP: ask the operator to continue with a new ceiling (set_migration_budget) or stop here with an honest report. Do not start the next batch until they answer.${noteSuffix}`,
      };
    }

    const remaining = v.remainingMicrocents !== null ? money(v.remainingMicrocents) : ceiling;
    const projLine =
      extrapolatedTotal !== null
        ? extrapolatedTotal > v.ceilingMicrocents
          ? `Projected total to finish is ~${money(extrapolatedTotal)} — ABOVE the ${ceiling} budget, so you will likely hit the ceiling before the run ends; warn the operator now so they can raise it or trim scope.`
          : `Projected total to finish is ~${money(extrapolatedTotal)}, within budget.`
        : "Not enough pages rebuilt yet to project the total.";
    return {
      ok: true,
      // "recorded so far" distinguishes this from the runner's budget notice,
      // which adds the turn currently in progress. Both numbers are right;
      // without the labels they read as a contradiction (2026-07-27: this
      // said "$3.83, within budget" in the same second the notice said
      // "$6.82, 86%").
      content: `Within budget. Budget ${ceiling}; spent ${spent} recorded so far (${remaining} remaining; the turn in progress is not counted yet); ${progress}. ${projLine} Keep going; re-check before the next batch.${noteSuffix}`,
    };
  },
};
