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
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${currency} ${amount}`;
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
