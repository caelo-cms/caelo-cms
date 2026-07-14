// SPDX-License-Identifier: MPL-2.0

/**
 * issue #280 — pure math for the migration cost gate. Kept side-effect
 * free (no DB, no I/O) so the extrapolation and currency arithmetic are
 * unit-testable in isolation; the DB roll-up lives in
 * `imports.get_run_cost` (ops/imports.ts).
 *
 * Money unit: Caelo records AI spend in MICROCENTS, where one microcent
 * is 1e-8 USD (see migration 0048 ai_pricing). So 1 USD = 1e8 microcents
 * and 1 cent = 1e6 microcents. The ceiling is stored in the same unit so
 * spend and ceiling compare with plain integer arithmetic.
 */

/** Microcents in one major currency unit (1 USD / 1 EUR at face value). */
export const MICROCENTS_PER_MAJOR_UNIT = 100_000_000;

/**
 * Convert a major-unit money amount the operator speaks in (e.g. `10` for
 * €10) into the microcent unit the run stores + spend is summed in.
 * Rounds to the nearest microcent — sub-microcent precision is noise.
 */
export function majorUnitsToMicrocents(major: number): number {
  return Math.round(major * MICROCENTS_PER_MAJOR_UNIT);
}

/** Inverse of {@link majorUnitsToMicrocents}: microcents → major units. */
export function microcentsToMajorUnits(microcents: number): number {
  return microcents / MICROCENTS_PER_MAJOR_UNIT;
}

/**
 * Smallest major-unit amount that still stores as ≥1 microcent. A positive
 * ceiling below this rounds to 0µ¢ — a "budget" that is really no budget and
 * would trip `overBudget` immediately (spend ≥ 0 always). Callers reject it.
 * At exactly 0.5µ¢, `Math.round` lands on 1µ¢, so the threshold is 0.5µ¢.
 */
export const MIN_CEILING_MAJOR_UNITS = 0.5 / MICROCENTS_PER_MAJOR_UNIT;

/**
 * True when a positive major-unit amount rounds down to 0 microcents — i.e.
 * it cannot be stored as a meaningful ceiling. The `set_cost_ceiling` op and
 * the `set_migration_budget` tool both reject such an amount so a "budget
 * set" state never immediately reads as over budget.
 */
export function roundsToZeroMicrocents(major: number): boolean {
  return majorUnitsToMicrocents(major) < 1;
}

/**
 * issue #297 — safety factor between the estimate the operator approved and
 * the ceiling the approval arms. The estimator is a band, not a promise
 * (run #15 was 15–65× off before #298's recalibration), so the ceiling
 * leaves headroom above `aiCostUsd.high` — but bounded headroom: the whole
 * point of #297 is that "$1.40 estimate, $600 real" can never happen again.
 * 3× keeps honest estimator noise from tripping the gate mid-run while
 * still capping the worst case at the same order of magnitude the operator
 * said yes to.
 */
export const ESTIMATE_CEILING_SAFETY_FACTOR = 3;

/**
 * issue #297 — the ceiling `imports.execute_proposal` arms from a stored
 * crawl-scope estimate. Discriminated on `ok`:
 *  - `ok: true`  → arm `ceilingMicrocents` (USD; the estimator prices in USD).
 *  - `ok: false` → the estimate cannot honestly fund a ceiling (`failed:true`,
 *    malformed, no cost band, or a band that rounds to 0µ¢). The caller must
 *    demand an EXPLICIT operator budget instead — never approve into a NULL
 *    ceiling once an estimate was shown (issue #297 acceptance).
 */
export type DerivedCeiling =
  | { ok: true; ceilingMicrocents: number; currency: "USD"; estimateHighUsd: number }
  | { ok: false; reason: string };

/**
 * Derive the auto-armed cost ceiling from a proposal's stored estimate
 * (`import_runs.estimate`, shape from @caelo-cms/site-importer). Pure and
 * defensive: the column is jsonb read as `unknown`, so every shape error is
 * an explicit `ok:false` reason, not a throw.
 */
export function deriveCeilingFromEstimate(estimate: unknown): DerivedCeiling {
  if (estimate === null || estimate === undefined || typeof estimate !== "object") {
    return { ok: false, reason: "the stored estimate is missing or malformed" };
  }
  const e = estimate as { failed?: unknown; aiCostUsd?: unknown };
  if (e.failed === true) {
    return { ok: false, reason: "the scope estimate FAILED — the crawl size is unknown" };
  }
  const band =
    typeof e.aiCostUsd === "object" && e.aiCostUsd !== null
      ? (e.aiCostUsd as { high?: unknown })
      : null;
  const high = band?.high;
  if (typeof high !== "number" || !Number.isFinite(high) || high < 0) {
    return { ok: false, reason: "the estimate carries no AI cost band" };
  }
  const ceilingMicrocents = majorUnitsToMicrocents(high * ESTIMATE_CEILING_SAFETY_FACTOR);
  // Representable minimum: a ceiling that stores as 0µ¢ reads as instantly
  // over budget (spend >= 0 always). A $0 band means the estimator saw zero
  // pages — an operator budget is the only honest ceiling then.
  if (ceilingMicrocents < 1) {
    return { ok: false, reason: "the estimated cost rounds to zero at microcent precision" };
  }
  return { ok: true, ceilingMicrocents, currency: "USD", estimateHighUsd: high };
}

/** Live gate verdict: `warn` at ≥80% of the ceiling, `trip` at ≥100%. */
export type BudgetGateLevel = "ok" | "warn" | "trip";

/**
 * Compare rolled-up spend against the armed ceiling. Integer-only math so
 * the 80% boundary is exact (`spent×5 ≥ ceiling×4` ⇔ spent/ceiling ≥ 0.8);
 * `fractionUsed` is display-only. Callers guarantee `ceilingMicrocents ≥ 1`
 * (set_cost_ceiling and deriveCeilingFromEstimate both reject 0µ¢).
 */
export function evaluateBudgetGate(input: { spentMicrocents: number; ceilingMicrocents: number }): {
  level: BudgetGateLevel;
  fractionUsed: number;
} {
  const { spentMicrocents, ceilingMicrocents } = input;
  const level: BudgetGateLevel =
    spentMicrocents >= ceilingMicrocents
      ? "trip"
      : spentMicrocents * 5 >= ceilingMicrocents * 4
        ? "warn"
        : "ok";
  return { level, fractionUsed: spentMicrocents / ceilingMicrocents };
}

/** Symbols for the currencies the migration flow commonly meets; anything
 *  else renders as `"<CODE> <amount>"` rather than guessing a glyph. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
  CHF: "CHF ",
};

/**
 * Format a microcent amount as human money in the given currency label,
 * e.g. `(1_000_000_000, "EUR")` → `"€10.00"`. Unknown currency codes get
 * a `"<CODE> 10.00"` prefix so the number is never shown bare. This is
 * DISPLAY ONLY — see the currency-conversion gap note on `computeRunCost`:
 * the amount is the USD-denominated spend rendered under the operator's
 * chosen label, not an FX-converted figure.
 */
export function formatMicrocentsAsMoney(microcents: number, currency: string): string {
  const major = microcentsToMajorUnits(microcents);
  const amount = major.toFixed(2);
  // Normalise casing on BOTH paths so the known-symbol lookup and the
  // unknown-code fallback are consistent — never leak the caller's casing
  // ("eur 10.00") into operator-facing text.
  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
}

/**
 * The run's progress-weighted cost extrapolation. `work` is pages rebuilt
 * vs total planned; cost is assumed to scale linearly with pages, so the
 * finish estimate is `spent / done × total`. All money fields are
 * microcents.
 */
export interface RunCostExtrapolation {
  /** Cost booked so far, microcents. */
  spentSoFar: number;
  /** Pages rebuilt (accepted) so far. */
  workDone: number;
  /** Pages planned in total for the run. */
  workTotal: number;
  /** Extrapolated total-to-finish cost, microcents; `null` when no work is
   *  done yet (0 pages rebuilt) — a divide-by-zero has no honest answer, so
   *  we surface "cannot extrapolate" rather than a fabricated number. */
  extrapolatedTotal: number | null;
}

/**
 * Extrapolate the full-run cost from spend-so-far and rebuild progress.
 *
 * `extrapolatedTotal = spentSoFar + costPerPage × pagesRemaining`, where
 * `costPerPage = spentSoFar / pagesDone` and `pagesRemaining` is clamped at
 * 0 (a run that rebuilt more pages than planned is already done, so its
 * extrapolated total is just what it has spent). Returns `null` for the
 * total when nothing is rebuilt yet.
 */
export function extrapolateRunCost(input: {
  spentMicrocents: number;
  pagesDone: number;
  pagesTotal: number;
}): RunCostExtrapolation {
  const { spentMicrocents, pagesDone, pagesTotal } = input;
  let extrapolatedTotal: number | null = null;
  if (pagesDone > 0) {
    const pagesRemaining = Math.max(0, pagesTotal - pagesDone);
    const costPerPage = spentMicrocents / pagesDone;
    extrapolatedTotal = Math.round(spentMicrocents + costPerPage * pagesRemaining);
  }
  return {
    spentSoFar: spentMicrocents,
    workDone: pagesDone,
    workTotal: pagesTotal,
    extrapolatedTotal,
  };
}

/** The full advisory cost picture for a run, assembled by `imports.get_run_cost`. */
export interface RunCost {
  /** Booked spend across the orchestrator + every subagent session, microcents. */
  spentMicrocents: number;
  /** ai_calls rows summed. */
  callCount: number;
  /** Subagent sessions folded into the total. */
  subagentSessionCount: number;
  /** Operator-confirmed ceiling, microcents; `null` when none set yet. */
  ceilingMicrocents: number | null;
  /** Currency label the ceiling was confirmed in; `null` with no ceiling. */
  ceilingCurrency: string | null;
  /** `ceilingMicrocents - spentMicrocents`; `null` when no ceiling set.
   *  Negative once spend has crossed the ceiling. */
  remainingMicrocents: number | null;
  /** True when a ceiling is set AND spend has reached/crossed it — the gate
   *  signal the flow acts on. */
  overBudget: boolean;
  /** Progress-weighted finish-cost estimate. */
  extrapolation: RunCostExtrapolation;
  /** False until Caelo grows an FX-rate source: spend is USD-denominated
   *  microcents shown under the operator's currency label, NOT converted. */
  currencyConversionApplied: boolean;
  /** Loud note about the conversion gap when the ceiling currency isn't USD;
   *  `null` when currency is USD (or unset) and the label is already honest. */
  currencyNote: string | null;
}

/**
 * Assemble the advisory {@link RunCost} from the summed spend, the stored
 * ceiling, and rebuild progress. Pure — the caller supplies the DB-read
 * numbers. Comparison is done in microcents on both sides; the
 * currency-conversion gap (USD spend vs a non-USD ceiling label) is
 * surfaced loudly in `currencyNote` rather than papered over with a
 * silent 1:1 assumption.
 */
export function computeRunCost(input: {
  spentMicrocents: number;
  callCount: number;
  subagentSessionCount: number;
  ceilingMicrocents: number | null;
  ceilingCurrency: string | null;
  pagesDone: number;
  pagesTotal: number;
}): RunCost {
  const { spentMicrocents, ceilingMicrocents, ceilingCurrency } = input;
  const remainingMicrocents =
    ceilingMicrocents === null ? null : ceilingMicrocents - spentMicrocents;
  const overBudget = ceilingMicrocents !== null && spentMicrocents >= ceilingMicrocents;
  const nonUsd = ceilingCurrency !== null && ceilingCurrency.toUpperCase() !== "USD";
  return {
    spentMicrocents,
    callCount: input.callCount,
    subagentSessionCount: input.subagentSessionCount,
    ceilingMicrocents,
    ceilingCurrency,
    remainingMicrocents,
    overBudget,
    extrapolation: extrapolateRunCost({
      spentMicrocents,
      pagesDone: input.pagesDone,
      pagesTotal: input.pagesTotal,
    }),
    currencyConversionApplied: false,
    currencyNote: nonUsd
      ? `Spend is USD-denominated; the ${ceilingCurrency} ceiling is compared 1:1 without an FX rate (Caelo has no rate source yet). Treat the amounts as approximate across currencies.`
      : null,
  };
}
