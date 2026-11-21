// SPDX-License-Identifier: MPL-2.0

/**
 * What an AI call costs, and the most it can cost before it runs: the pure
 * pricing every spend ledger shares (#297, #1477, #1653, #1654). The admin's
 * `ai_calls` ledger and the gateway's visitor-AI ledger (cms_public) price
 * the same way from the same code, so a cap means the same on both sides.
 *
 * Money unit: microcents (1e-8 USD); pricing rows are per 1K tokens for
 * text and per image for image ops (see migration 0048).
 *
 * Prices that depend on prompt length (#1477): Claude Haiku 5.5 bills a
 * request whose prompt is over 100,000 tokens at five times its normal
 * rates, on every lane. The prompt length counts cache reads and writes
 * too, and each request is priced on its own.
 */

/** The prompt-length fields of an `ai_pricing` row; absent or null = one flat card. */
export interface LongPromptPricing {
  readonly longPromptThresholdTokens?: number | null;
  readonly longPromptMultiplier?: number | null;
}

/**
 * The factor on every rate for a request with `promptTokens` of input.
 *
 * @param promptTokens all input tokens of the request (fresh + cache read +
 *   cache write). At exactly the threshold the normal rates still apply.
 * @returns 1 for a row without prompt-length pricing or a prompt at or under
 *   the threshold, else the row's multiplier.
 */
export function longPromptRateMultiplier(
  pricing: LongPromptPricing | null | undefined,
  promptTokens: number,
): number {
  const threshold = pricing?.longPromptThresholdTokens;
  const multiplier = pricing?.longPromptMultiplier;
  if (threshold == null || multiplier == null) return 1;
  return promptTokens > threshold ? multiplier : 1;
}

/** The rates of one `ai_pricing` row (per 1K tokens; per image for image rows). */
export interface PricingRow extends LongPromptPricing {
  inputMicrocents: number;
  outputMicrocents: number | null;
  /** Cache-READ (`cache_read_input_tokens`) rate per 1K tokens. */
  cachedMicrocents: number | null;
  /** Cache-WRITE (`cache_creation_input_tokens`) rate per 1K tokens; NULL
   *  lets the cost mapper default to 1.25x the input rate. */
  cacheCreationMicrocents: number | null;
}

/**
 * A candidate ai_pricing row for one (provider, operationType), carrying the
 * fields `pickPricingRow` needs to choose the row in force at a given time:
 * the rates plus the model (for exact-vs-wildcard specificity) and the
 * validity/effective timestamps as epoch ms (null bound = open-ended).
 */
export interface PricingCandidate extends PricingRow {
  model: string;
  effectiveFromMs: number;
  validFromMs: number | null;
  validToMs: number | null;
}

/**
 * Pick the ai_pricing row in force at `nowMs` from candidates already scoped
 * to one (provider, operationType). Eligibility: `effective_from` has passed
 * AND the `[valid_from, valid_to]` window (either bound open) contains
 * `nowMs`. Precedence among the eligible: exact-model beats the wildcard `*`,
 * then a DATED window beats the undated back-compat row, then the
 * latest-starting window wins, then the latest `effective_from`. Returns the
 * `PricingRow` rate subset, or null when nothing is eligible.
 *
 * Pure + exported so validity-window selection is unit-testable without a DB.
 */
export function pickPricingRow(
  candidates: readonly PricingCandidate[],
  requestedModel: string,
  nowMs: number,
): PricingRow | null {
  const eligible = candidates.filter(
    (c) =>
      c.effectiveFromMs <= nowMs &&
      (c.validFromMs === null || c.validFromMs <= nowMs) &&
      (c.validToMs === null || c.validToMs >= nowMs),
  );
  if (eligible.length === 0) return null;
  const exact = (c: PricingCandidate) => (c.model === requestedModel ? 1 : 0);
  const dated = (c: PricingCandidate) => (c.validFromMs !== null || c.validToMs !== null ? 1 : 0);
  // Later in each ranked dimension wins; `beats(b, a)` = "b outranks a".
  const beats = (b: PricingCandidate, a: PricingCandidate): boolean => {
    if (exact(b) !== exact(a)) return exact(b) > exact(a);
    if (dated(b) !== dated(a)) return dated(b) > dated(a);
    const bf = b.validFromMs ?? Number.NEGATIVE_INFINITY;
    const af = a.validFromMs ?? Number.NEGATIVE_INFINITY;
    if (bf !== af) return bf > af;
    return b.effectiveFromMs > a.effectiveFromMs;
  };
  const best = eligible.reduce((a, b) => (beats(b, a) ? b : a));
  return {
    inputMicrocents: best.inputMicrocents,
    outputMicrocents: best.outputMicrocents,
    cachedMicrocents: best.cachedMicrocents,
    cacheCreationMicrocents: best.cacheCreationMicrocents,
    longPromptThresholdTokens: best.longPromptThresholdTokens ?? null,
    longPromptMultiplier: best.longPromptMultiplier ?? null,
  };
}

// ---------------------------------------------------------------------------
// The cost of a finished call (issue #297).
// ---------------------------------------------------------------------------
export interface AiCallCostInput {
  operationType: "text" | "image";
  inputTokens: number;
  outputTokens: number;
  /** Cache-READ tokens (`cache_read_input_tokens`), billed at the cheap
   *  `cachedMicrocents` rate. */
  cachedTokens: number;
  /** Cache-WRITE tokens (`cache_creation_input_tokens`), billed at
   *  `cacheCreationMicrocents` (~1.25x the input rate). */
  cacheCreationTokens: number;
  /** The longest single prompt among the requests this row sums up. Omitted =
   *  `inputTokens`, which is exact for a one-request call and on the high side
   *  for an aggregate, so a caller that sums requests can only overcount by
   *  leaving it out. */
  largestPromptTokens?: number;
  imageCount: number;
}

export interface AiCallCost {
  /** Microcents to store on the ai_calls row. */
  costMicrocents: number;
  /** True when the call did real work but no pricing row exists — the row
   *  will store 0 and every spend roll-up reading it is UNDERSTATED. */
  unpriced: boolean;
}

/**
 * Map a pricing row (or a lookup miss, `null`) onto a call's token/image
 * counts. Three input lanes bill at three rates: fresh input at
 * `inputMicrocents`, cache-READ at `cachedMicrocents` (else input rate), and
 * cache-WRITE at `cacheCreationMicrocents` (else 1.25x the input rate, the
 * Anthropic cache-write premium).
 *
 * Double-count decision: the Vercel AI SDK's flat `usage.inputTokens` is the
 * GRAND total of all three input lanes — see `asLanguageModelUsage`
 * (`ai/dist/index.js`: `inputTokens = usage.inputTokens.total`) fed by the
 * Anthropic adapter (`@ai-sdk/anthropic`: `total = input(fresh) +
 * cacheCreation + cacheRead`). So the fresh remainder billed at the full
 * input rate is `inputTokens - cachedTokens - cacheCreationTokens`; failing
 * to subtract cacheCreationTokens would bill cache writes twice (once at the
 * input rate inside `billedInput`, once at the cache-write rate).
 *
 * Prompt-length pricing (#1477): a row with `longPromptThresholdTokens` bills
 * every lane at its multiplier once the prompt is over the threshold. An
 * `ai_calls` row of a chat turn sums all of the turn's requests, so the whole
 * turn takes the higher card when ANY of its requests crossed the threshold.
 * That can overcount a turn that started below it, by at most the multiplier.
 * Pricing each request would need per-step rows; an overcount is the safe side
 * of this trade because budget caps read this number.
 */
export function computeAiCallCostMicrocents(
  pricing: PricingRow | null,
  call: AiCallCostInput,
): AiCallCost {
  const didWork =
    call.operationType === "image" ? call.imageCount > 0 : call.inputTokens + call.outputTokens > 0;
  if (pricing === null) {
    return { costMicrocents: 0, unpriced: didWork };
  }
  if (call.operationType === "image") {
    return { costMicrocents: pricing.inputMicrocents * call.imageCount, unpriced: false };
  }
  const tier = longPromptRateMultiplier(pricing, call.largestPromptTokens ?? call.inputTokens);
  const inRate = pricing.inputMicrocents * tier;
  const outRate = (pricing.outputMicrocents ?? 0) * tier;
  const cacheReadRate = (pricing.cachedMicrocents ?? pricing.inputMicrocents) * tier;
  const cacheCreationRate =
    (pricing.cacheCreationMicrocents ?? pricing.inputMicrocents * 1.25) * tier;
  const billedInput = Math.max(0, call.inputTokens - call.cachedTokens - call.cacheCreationTokens);
  const costMicrocents = Math.round(
    (billedInput * inRate) / 1000 +
      (call.cachedTokens * cacheReadRate) / 1000 +
      (call.cacheCreationTokens * cacheCreationRate) / 1000 +
      (call.outputTokens * outRate) / 1000,
  );
  return { costMicrocents, unpriced: false };
}

/** What a text request can cost at most, before it runs (#1653). */
export interface WorstCaseTextInput {
  /** An upper bound of the request's prompt tokens (every input lane). */
  promptTokens: number;
  /** The request's output ceiling (`maxOutputTokens`), thinking included. */
  maxOutputTokens: number;
}

/**
 * The most a text request can cost: every prompt token at the dearest
 * input lane (a cache WRITE, ~1.25x the input rate — a cold prompt may be
 * written to the cache in full), every output token the ceiling allows,
 * and the prompt-length card when the prompt bound is over its threshold.
 * A reservation at this amount cannot be overrun by the call it covers.
 * Null pricing → null: the caller decides whether an unpriced call may run.
 */
export function worstCaseTextMicrocents(
  pricing: PricingRow | null,
  req: WorstCaseTextInput,
): number | null {
  if (pricing === null) return null;
  const tier = longPromptRateMultiplier(pricing, req.promptTokens);
  const inRate = Math.max(
    pricing.inputMicrocents,
    pricing.cacheCreationMicrocents ?? pricing.inputMicrocents * 1.25,
  );
  const outRate = pricing.outputMicrocents ?? 0;
  return Math.ceil(
    ((req.promptTokens * inRate) / 1000 + (req.maxOutputTokens * outRate) / 1000) * tier,
  );
}

// ---------------------------------------------------------------------------
// The prompt bound of a request before it runs (#1653).
// ---------------------------------------------------------------------------

/** Tokens a provider adds to every request around the caller's content. */
export const PROVIDER_REQUEST_OVERHEAD_TOKENS = 2_000;

/**
 * Tokens one image counts at most, whatever its size: providers scale an
 * image down before they count it (about 1,600 tokens at most for Claude,
 * fewer for the others), so its base64 bytes say nothing about its cost.
 */
export const IMAGE_TOKEN_BOUND = 5_000;

/** Media parts in any of the message shapes the AI SDK and Caelo use. */
function isMediaPart(o: Record<string, unknown>): boolean {
  return (
    o.type === "image" ||
    o.type === "file" ||
    o.type === "media" ||
    o.type === "image-data" ||
    typeof o.mediaType === "string" ||
    typeof o.mimeType === "string"
  );
}

/**
 * An upper bound of the tokens a value sends: one token per UTF-8 byte of
 * its text (a byte-level BPE token is at least one byte), {@link
 * IMAGE_TOKEN_BOUND} per image or file part instead of its encoded bytes.
 * Several times the real count for prose — the safe side for a
 * reservation, which is settled to the real count after the call.
 */
export function tokenBoundOf(value: unknown): number {
  // The UTF-8 length of the value's JSON text, with each media part
  // counted at its token bound instead: what the provider receives is at
  // most this many bytes of text plus the images.
  if (typeof value === "function" || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value), "utf8");
  if (value === null || typeof value !== "object") return String(value).length;
  if (Array.isArray(value)) {
    let n = 2;
    for (const v of value) n += tokenBoundOf(v) + 1;
    return n;
  }
  const o = value as Record<string, unknown>;
  if (isMediaPart(o)) {
    // The part's own short fields (type, name) still travel; its data does not count as text.
    let n = IMAGE_TOKEN_BOUND;
    for (const [k, v] of Object.entries(o))
      if (typeof v === "string" && v.length < 1_000) n += Buffer.byteLength(k + v, "utf8") + 6;
    return n;
  }
  let n = 2;
  for (const [k, v] of Object.entries(o))
    n += Buffer.byteLength(JSON.stringify(k), "utf8") + tokenBoundOf(v) + 2;
  return n;
}

/** An upper bound of a request's prompt tokens: its parts plus the provider's wrapping. */
export function promptTokenBound(...parts: readonly unknown[]): number {
  let n = PROVIDER_REQUEST_OVERHEAD_TOKENS;
  for (const p of parts) n += tokenBoundOf(p);
  return n;
}
