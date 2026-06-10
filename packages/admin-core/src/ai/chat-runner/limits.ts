// SPDX-License-Identifier: MPL-2.0

/**
 * Token-budget + cost-tracking constants and helpers for the chat-runner.
 * Extracted verbatim from the pre-split `chat-runner.ts`.
 */

export const DEFAULT_INPUT_COST_PER_M = 15; // Opus 4.7 input rate, USD per 1M tokens
export const DEFAULT_OUTPUT_COST_PER_M = 75;
/**
 * v0.2.53 — Default output-token ceiling per provider call.
 * 16384 covers compose-page-style turns (text + multi-tool_use batches +
 * post-tool summary) on every modern Claude / GPT-4o / Gemini 2.5 model.
 * The pre-v0.2.53 4096 default was Sonnet-3 era and routinely truncated
 * tool_use blocks mid-stream on Opus 4.7 / Sonnet 4.6. Operators can
 * tune higher (up to 200k) per provider via /security/ai.
 */
export const MAX_OUTPUT_TOKENS_DEFAULT = 16384;

export function microcents(usd: number): number {
  // 1 USD = 1e8 microcents.
  return Math.round(usd * 1e8);
}

/**
 * Cost-cap pre-flight formula (P10.5 #3). Subtracts cached input tokens —
 * the soft cap checks the *billable* spend so far so it can fire before the
 * next provider call.
 */
export function costCapUsd(
  totalIn: number,
  totalCached: number,
  totalOut: number,
  inputCost: number,
  outputCost: number,
): number {
  return ((totalIn - totalCached) / 1_000_000) * inputCost + (totalOut / 1_000_000) * outputCost;
}

/**
 * Final turn cost (the streaming `usage` event + the `ai_calls` row's
 * microcent figure). Intentionally does NOT subtract cached tokens — this
 * preserves the pre-split behaviour exactly; the canonical billed price for
 * the DB row comes from the pricing table inside `chat.record_ai_call`.
 */
export function finalUsdCost(
  totalIn: number,
  totalOut: number,
  inputCost: number,
  outputCost: number,
): number {
  return (totalIn / 1_000_000) * inputCost + (totalOut / 1_000_000) * outputCost;
}
