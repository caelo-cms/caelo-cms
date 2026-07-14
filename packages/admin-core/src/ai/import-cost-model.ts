// SPDX-License-Identifier: MPL-2.0

/**
 * issue #298 — the import/migration AI-cost model: calls × context, not
 * $/page.
 *
 * Run #15 (searchviu replay, `run-logs/run15-analysis.md` +
 * `run-logs/dev-run15.log`) showed the operator "$0.28–$1.40 for 14 pages"
 * while the main session's reconstructed real cost was $19–$92: 107 API
 * calls, 30,112,008 input tokens, 136,076 output. The real cost driver is the NUMBER OF
 * API CALLS times the PER-CALL INPUT CONTEXT — every loop re-sends the
 * whole conversation (system prompt + context blocks + skill bodies +
 * accumulated tool results), so per-call input started at ~103K tokens and
 * ramped to ~556K by the end of the run.
 *
 * The model is deliberately pure: token constants live here (each cites the
 * run-15 telemetry it was measured from), but PRICES do not — callers pass
 * the current provider/model rates from `ai_pricing` (microcents per 1K
 * tokens, migration 0048). The propose tool resolves rates; this module
 * only multiplies.
 *
 * A note on the ramp parameterisation: issue #298 sketches the history
 * growth "per loop within a turn", but the telemetry shows history survives
 * turn boundaries — run #15 turn 4 opened at 188K/call and turn 5 at
 * 253K/call, not back at the 103K base. The honest ramp is therefore
 * PER CALL ACROSS THE WHOLE SESSION: per-call input ≈ base + slope × i for
 * call index i, capped at the largest context the provider window admits.
 */

/**
 * API calls (chat-runner loops) per rebuilt page on TODAY's singular-op
 * build path. Run #15 main session: 36× add_module_to_page + 29×
 * set_page_module_content + 9× create_content_instance + 8× create_page +
 * 8× edit_module + review/fidelity round-trips ≈ 98 build calls for 14
 * pages ⇒ 7 calls/page.
 */
export const IMPORT_CALLS_PER_PAGE = 7;

/**
 * Expected calls/page once issue #299's bulk build ops (`build_page`,
 * `_many` variants) land: one build_page call + content fill + one
 * review/fidelity round-trip ≈ 3. NOT the default — switch the default to
 * this constant when #299 merges and a replay confirms the ratio.
 */
export const IMPORT_CALLS_PER_PAGE_WITH_BULK_BUILD = 3;

/**
 * Calls the flow spends OUTSIDE per-page building: understand phase
 * (inspect_external_page / map_external_page_types), theme + compose,
 * checkpoints, closing report. Run #15: 107 total calls − 14 pages × 7
 * build calls = 9 overhead calls (its first two 4-loop turns were exactly
 * this understand/plan work).
 */
export const IMPORT_FLOW_OVERHEAD_CALLS = 9;

/**
 * Input tokens a FRESH call pays before any history: system prompt +
 * context blocks + skill bodies. Measured at loop 0 of turn 1: 103,514
 * (run #15), 103K flat across runs #13/#14 too (`dev-run13/14.log`).
 * Issue #300's context diet attacks this constant; recalibrate there.
 */
export const BASE_CONTEXT_TOKENS_PER_CALL = 103_000;

/**
 * Average growth of per-call input per additional call in the session —
 * each call appends its tool results (HTML bodies!) and assistant text to
 * the history every later call re-sends. Run #15: per-call input grew
 * ~104K (call 0) → ~556K (call ~106): (556K − 104K) / 106 ≈ 4.3K/call.
 * Cross-checked against the measured input totals of runs #13/#14/#15
 * (10.48M / 26.41M / 30.11M): the ramp predicts them at 0.77× / 0.81× /
 * 1.18× — all well inside the 2× acceptance band of issue #298.
 */
export const HISTORY_GROWTH_TOKENS_PER_CALL = 4_300;

/**
 * Ceiling on per-call input: history cannot outgrow the provider context
 * window (compaction kicks in). 556K is the largest per-call input observed
 * in run #15 (turn 8, loop 24, 1M-window Sonnet). Long runs price as
 * `cap × calls` past the ramp instead of exploding quadratically.
 */
export const MAX_CONTEXT_TOKENS_PER_CALL = 556_000;

/**
 * Output tokens per call. Run #15: 136K output / 107 calls ≈ 1.27K
 * (reconstruction in run15-analysis.md; raw turn-final telemetry reads up
 * to ~1.9K/call). Output is <3% of the bill at Sonnet-like rate ratios —
 * precision here is not load-bearing.
 */
export const OUTPUT_TOKENS_PER_CALL = 1_300;

/**
 * Fraction of input tokens priced at the CACHE-READ rate in the LOW bound
 * of the band. 0.6 is deliberately conservative: Anthropic prompt caching
 * on a stable prefix reached ~90% in the run-15 reconstruction, but the
 * estimate's low end must not promise best-case cache behaviour the
 * operator's provider may not deliver. The HIGH bound assumes no cache.
 */
export const DEFAULT_CACHED_INPUT_FRACTION = 0.6;

/** Microcents (1e-8 USD, migration 0048) in one USD. */
const MICROCENTS_PER_USD = 100_000_000;

/** Tunable knobs; every default is a measured constant above. */
export interface ImportCostModelParams {
  /** Calls per rebuilt page. Default {@link IMPORT_CALLS_PER_PAGE}. */
  readonly callsPerPage?: number;
  /** Non-page flow calls. Default {@link IMPORT_FLOW_OVERHEAD_CALLS}. */
  readonly flowOverheadCalls?: number;
  /** Fresh-call input floor. Default {@link BASE_CONTEXT_TOKENS_PER_CALL}. */
  readonly baseContextTokensPerCall?: number;
  /** Ramp slope. Default {@link HISTORY_GROWTH_TOKENS_PER_CALL}. */
  readonly historyGrowthTokensPerCall?: number;
  /** Ramp ceiling. Default {@link MAX_CONTEXT_TOKENS_PER_CALL}. */
  readonly maxContextTokensPerCall?: number;
  /** Output per call. Default {@link OUTPUT_TOKENS_PER_CALL}. */
  readonly outputTokensPerCall?: number;
  /** Cache-read share in the low bound. Default {@link DEFAULT_CACHED_INPUT_FRACTION}. */
  readonly cachedInputFraction?: number;
}

/**
 * Text rates for the CURRENT provider/model, microcents per 1K tokens —
 * the exact unit `ai_pricing` stores (migration 0048). The tool resolves
 * these via `ai_pricing.list`; the model never hardcodes a dollar figure.
 */
export interface ImportModelRates {
  readonly inputMicrocentsPer1K: number;
  readonly outputMicrocentsPer1K: number;
  /** Cache-READ rate; null = provider prices no cache tier, so the low
   *  bound collapses onto the high bound (no invented discount). */
  readonly cachedInputMicrocentsPer1K: number | null;
}

interface ResolvedParams {
  callsPerPage: number;
  flowOverheadCalls: number;
  base: number;
  slope: number;
  cap: number;
  outputPerCall: number;
  cachedFraction: number;
}

function resolve(params?: ImportCostModelParams): ResolvedParams {
  return {
    callsPerPage: params?.callsPerPage ?? IMPORT_CALLS_PER_PAGE,
    flowOverheadCalls: params?.flowOverheadCalls ?? IMPORT_FLOW_OVERHEAD_CALLS,
    base: params?.baseContextTokensPerCall ?? BASE_CONTEXT_TOKENS_PER_CALL,
    slope: params?.historyGrowthTokensPerCall ?? HISTORY_GROWTH_TOKENS_PER_CALL,
    cap: params?.maxContextTokensPerCall ?? MAX_CONTEXT_TOKENS_PER_CALL,
    outputPerCall: params?.outputTokensPerCall ?? OUTPUT_TOKENS_PER_CALL,
    cachedFraction: params?.cachedInputFraction ?? DEFAULT_CACHED_INPUT_FRACTION,
  };
}

/** Expected API calls for a run rebuilding `pages` pages. */
export function estimateImportCallCount(pages: number, params?: ImportCostModelParams): number {
  const p = resolve(params);
  if (pages <= 0) return 0;
  return Math.ceil(pages * p.callsPerPage + p.flowOverheadCalls);
}

/** How many calls of a `calls`-long session sit on the ramp (per-call
 *  input still below the cap); the rest price at the cap. */
function rampCalls(calls: number, p: ResolvedParams): number {
  if (p.slope <= 0) return calls;
  return Math.min(calls, Math.floor((p.cap - p.base) / p.slope) + 1);
}

/**
 * Total input/output tokens for a session of `calls` API calls under the
 * arithmetic ramp: per-call input = base + slope×i, capped. Closed form —
 * ramp region is an arithmetic series, capped region is flat.
 */
export function estimateImportTokens(
  calls: number,
  params?: ImportCostModelParams,
): { inputTokens: number; outputTokens: number } {
  const p = resolve(params);
  if (calls <= 0) return { inputTokens: 0, outputTokens: 0 };
  const n = rampCalls(calls, p);
  const ramp = n * p.base + (p.slope * n * (n - 1)) / 2;
  const capped = (calls - n) * p.cap;
  return {
    inputTokens: Math.round(ramp + capped),
    outputTokens: Math.round(calls * p.outputPerCall),
  };
}

/**
 * Price a token total as a [low, high] USD band. High = every input token
 * at the full input rate (no cache). Low = `cachedInputFraction` of input
 * at the cache-read rate. Output always prices at the output rate — cache
 * does not discount output.
 */
export function priceImportTokens(
  tokens: { inputTokens: number; outputTokens: number },
  rates: ImportModelRates,
  cachedInputFraction: number = DEFAULT_CACHED_INPUT_FRACTION,
): { lowUsd: number; highUsd: number } {
  const usdPerToken = (microcentsPer1K: number): number =>
    microcentsPer1K / 1000 / MICROCENTS_PER_USD;
  const outUsd = tokens.outputTokens * usdPerToken(rates.outputMicrocentsPer1K);
  const highUsd = tokens.inputTokens * usdPerToken(rates.inputMicrocentsPer1K) + outUsd;
  if (rates.cachedInputMicrocentsPer1K === null) {
    // No cache tier priced — a discount would be invented, not measured.
    return { lowUsd: highUsd, highUsd };
  }
  const f = Math.min(1, Math.max(0, cachedInputFraction));
  const blendedInputUsdPerToken =
    (1 - f) * usdPerToken(rates.inputMicrocentsPer1K) +
    f * usdPerToken(rates.cachedInputMicrocentsPer1K);
  const lowUsd = tokens.inputTokens * blendedInputUsdPerToken + outUsd;
  return { lowUsd, highUsd };
}

/** The full estimate the propose tool stores on the proposal. */
export interface ImportAiCostEstimate {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD, rounded to cents for display; low ≤ high. */
  readonly aiCostUsd: { readonly low: number; readonly high: number };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * pages → calls → tokens → USD band, in one step. This is what replaces
 * the old `pages × $0.02–$0.10` heuristic in the propose flow.
 */
export function estimateImportAiCost(
  pages: number,
  rates: ImportModelRates,
  params?: ImportCostModelParams,
): ImportAiCostEstimate {
  const p = resolve(params);
  const calls = estimateImportCallCount(pages, params);
  const tokens = estimateImportTokens(calls, params);
  const { lowUsd, highUsd } = priceImportTokens(tokens, rates, p.cachedFraction);
  return {
    calls,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    aiCostUsd: { low: round2(lowUsd), high: round2(highUsd) },
  };
}

// ---------------------------------------------------------------------------
// Learning loop — calibrate the constants from completed-run telemetry.
// ---------------------------------------------------------------------------

/**
 * Aggregates of a completed run, as `ai_calls` can provide them. NOTE:
 * `ai_calls` records ONE ROW PER TURN (runChatTurn accumulates its loops
 * into a single row — see chat-runner/index.ts UsageAccumulator), so the
 * row count is `turnCount`, NOT the API-call count. Pass `apiCalls` when
 * loop telemetry is available; otherwise the calibration inverts the token
 * model to infer it and says so.
 */
export interface ImportRunObservation {
  /** ai_calls rows across the run's orchestrator + subagent sessions. */
  readonly turnCount: number;
  /** SUM(ai_calls.input_tokens) — the billed input total. */
  readonly inputTokens: number;
  /** SUM(ai_calls.output_tokens). */
  readonly outputTokens: number;
  /** Pages actually rebuilt (import_pages.accepted_page_id count). */
  readonly pagesBuilt: number;
  /** Exact loop count when the dev-server loop telemetry is at hand. */
  readonly apiCalls?: number;
}

/**
 * Invert the ramp model: given a billed input-token total, how many calls
 * does the model say produced it? Piecewise inverse of
 * {@link estimateImportTokens} — quadratic on the ramp, linear past the
 * cap. Run #15 sanity: 35.8M tokens inverts to ≈108 calls (real: 107).
 */
export function inferCallCountFromTokens(
  inputTokens: number,
  params?: ImportCostModelParams,
): number {
  const p = resolve(params);
  if (inputTokens <= 0) return 0;
  if (p.slope <= 0) return Math.round(inputTokens / Math.min(p.base, p.cap));
  const nCap = Math.floor((p.cap - p.base) / p.slope) + 1;
  const rampTotal = nCap * p.base + (p.slope * nCap * (nCap - 1)) / 2;
  if (inputTokens > rampTotal) {
    return Math.round(nCap + (inputTokens - rampTotal) / p.cap);
  }
  // Solve (slope/2)·C² + (base − slope/2)·C − inputTokens = 0 for C > 0.
  const b = p.base - p.slope / 2;
  const c = (-b + Math.sqrt(b * b + 2 * p.slope * inputTokens)) / p.slope;
  return Math.max(1, Math.round(c));
}

/** Per-run observed constants, derived from one completed run. */
export interface RunCalibration {
  /** Loop count used — observed when supplied, else model-inverted. */
  readonly apiCalls: number;
  /** True when `apiCalls` was inferred from tokens, not observed. */
  readonly callsInferred: boolean;
  /** (apiCalls − flow overhead) / pagesBuilt; null when no pages built. */
  readonly callsPerPage: number | null;
  /** inputTokens / apiCalls — pure observation, no model assumptions. */
  readonly meanInputTokensPerCall: number | null;
  /** Observed fresh-call context floor, holding the ramp SLOPE fixed at
   *  the measured constant: mean − slope×(mean ramp index). One aggregate
   *  equation cannot pin base AND slope at once — this is the base-axis
   *  projection; `historyGrowthTokensPerCall` is the slope-axis one.
   *  Null when the run made no calls. */
  readonly baseContextTokensPerCall: number | null;
  /** Observed ramp slope, holding BASE fixed at the measured constant:
   *  2×(mean − base)/(apiCalls − 1). Null for runs of <2 calls. */
  readonly historyGrowthTokensPerCall: number | null;
}

/**
 * Derive observed CALLS_PER_PAGE / BASE_CONTEXT (and the slope-axis twin)
 * from one finished run. Fuel for `imports.get_run_calibration`'s
 * "observed vs estimated" surface — estimates get data-driven instead of
 * hand-measured.
 */
export function deriveRunCalibration(
  obs: ImportRunObservation,
  params?: ImportCostModelParams,
): RunCalibration {
  const p = resolve(params);
  const callsInferred = obs.apiCalls === undefined;
  const apiCalls = obs.apiCalls ?? inferCallCountFromTokens(obs.inputTokens, params);
  if (apiCalls <= 0) {
    return {
      apiCalls: 0,
      callsInferred,
      callsPerPage: null,
      meanInputTokensPerCall: null,
      baseContextTokensPerCall: null,
      historyGrowthTokensPerCall: null,
    };
  }
  const callsPerPage =
    obs.pagesBuilt > 0 ? Math.max(0, (apiCalls - p.flowOverheadCalls) / obs.pagesBuilt) : null;
  const mean = obs.inputTokens / apiCalls;
  // Mean growth above base at this run length under the fixed-slope ramp.
  const n = rampCalls(apiCalls, p);
  const meanGrowth = ((p.slope * n * (n - 1)) / 2 + (apiCalls - n) * (p.cap - p.base)) / apiCalls;
  return {
    apiCalls,
    callsInferred,
    callsPerPage,
    meanInputTokensPerCall: Math.round(mean),
    baseContextTokensPerCall: Math.max(0, Math.round(mean - meanGrowth)),
    historyGrowthTokensPerCall:
      apiCalls >= 2 ? Math.max(0, Math.round((2 * (mean - p.base)) / (apiCalls - 1))) : null,
  };
}

/** Cross-run calibration rollup ("based on N previous runs"). */
export interface ImportCostCalibration {
  readonly runsUsed: number;
  /** Pages-weighted mean; null when no run built pages. */
  readonly callsPerPage: number | null;
  /** Calls-weighted mean; null when no run made calls. */
  readonly baseContextTokensPerCall: number | null;
  /** True when ANY folded run had its call count inferred from tokens. */
  readonly anyCallsInferred: boolean;
}

/**
 * Fold completed-run aggregates into updated model constants. Weighted by
 * work (pages for calls/page, calls for base context) so a 2-page pilot
 * does not out-vote a 50-page migration.
 */
export function calibrateImportCostModel(
  runs: readonly ImportRunObservation[],
  params?: ImportCostModelParams,
): ImportCostCalibration {
  const p = resolve(params);
  let pages = 0;
  let buildCalls = 0;
  let calls = 0;
  let baseWeighted = 0;
  let anyCallsInferred = false;
  for (const run of runs) {
    const cal = deriveRunCalibration(run, params);
    anyCallsInferred ||= cal.callsInferred;
    if (run.pagesBuilt > 0 && cal.apiCalls > 0) {
      pages += run.pagesBuilt;
      buildCalls += Math.max(0, cal.apiCalls - p.flowOverheadCalls);
    }
    if (cal.apiCalls > 0 && cal.baseContextTokensPerCall !== null) {
      calls += cal.apiCalls;
      baseWeighted += cal.baseContextTokensPerCall * cal.apiCalls;
    }
  }
  return {
    runsUsed: runs.length,
    callsPerPage: pages > 0 ? buildCalls / pages : null,
    baseContextTokensPerCall: calls > 0 ? Math.round(baseWeighted / calls) : null,
    anyCallsInferred,
  };
}
