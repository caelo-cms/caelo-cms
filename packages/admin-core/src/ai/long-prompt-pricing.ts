// SPDX-License-Identifier: MPL-2.0

/**
 * Prices that depend on prompt length (#1477). Claude Haiku 5.5 bills a
 * request whose prompt is over 100,000 tokens at five times its normal rates,
 * on every lane: input, output, cache read and cache write. The prompt length
 * counts cache reads and writes too, and each request is priced on its own.
 *
 * Pure, so the billing mapper, the live budget gate and the import estimator
 * all answer the same way.
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
