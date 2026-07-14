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
  cachedTokens: number;
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
 * counts. Cached input tokens bill at the cache-read rate when the row has
 * one, else at the input rate (matching pre-#297 behaviour).
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
  const cacheRate = pricing.cachedMicrocents ?? inRate;
  const billedInput = Math.max(0, call.inputTokens - call.cachedTokens);
  const costMicrocents = Math.round(
    (billedInput * inRate) / 1000 +
      (call.cachedTokens * cacheRate) / 1000 +
      (call.outputTokens * outRate) / 1000,
  );
  return { costMicrocents, unpriced: false };
}
