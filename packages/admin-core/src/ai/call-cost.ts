// SPDX-License-Identifier: MPL-2.0

/**
 * issue #297 — pure cost mapping for `chat.record_ai_call`.
 *
 * Extracted from the op handler so the arithmetic AND the unpriced-call
 * detection are unit-testable without a DB. Run #14's report showed $0.00
 * despite 15+ ai_calls rows: the ai_pricing seed only carried
 * `('anthropic','claude-opus-4-7')` while the default chat model is
 * `claude-sonnet-5`, so `lookupPricing` missed and every row silently
 * stored `cost_estimate_microcents = 0` — a hidden fallback (CLAUDE.md §2)
 * that made the whole cost gate blind. Migration 0155 seeds the current
 * model catalog; this module makes any FUTURE gap loud instead of $0-quiet
 * (`unpriced: true` → stderr breadcrumb at the write site + an
 * `unpricedCallCount` surface on `imports.get_run_cost`).
 *
 * Money unit: microcents (1e-8 USD); pricing rows are per 1K tokens for
 * text and per image for image ops (see migration 0048).
 */

import type { PricingRow } from "./pricing-cache.js";

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
  const inRate = pricing.inputMicrocents;
  const outRate = pricing.outputMicrocents ?? 0;
  const cacheReadRate = pricing.cachedMicrocents ?? inRate;
  const cacheCreationRate = pricing.cacheCreationMicrocents ?? inRate * 1.25;
  const billedInput = Math.max(0, call.inputTokens - call.cachedTokens - call.cacheCreationTokens);
  const costMicrocents = Math.round(
    (billedInput * inRate) / 1000 +
      (call.cachedTokens * cacheReadRate) / 1000 +
      (call.cacheCreationTokens * cacheCreationRate) / 1000 +
      (call.outputTokens * outRate) / 1000,
  );
  return { costMicrocents, unpriced: false };
}
