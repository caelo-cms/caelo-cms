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

/**
 * Run #8 R1 — default ceiling for adaptive-thinking-class Claude models
 * (Sonnet 5, Opus 4.6/4.7/4.8, Sonnet 4.6, Fable/Mythos). On these
 * models `max_tokens` bounds thinking + visible output TOGETHER, and
 * adaptive thinking on a hard migration turn can consume the whole
 * 16384 budget — run #8 saw two turns end with EMPTY content at exactly
 * output_tokens=16384. All of these models support >=64k streamed
 * output, so 32768 is comfortably safe and leaves the visible half of
 * the turn room to exist.
 */
export const MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT = 32768;

/**
 * Same model-class detection as `resolveThinkingOption` in the Anthropic
 * provider: models that take adaptive thinking (and therefore share the
 * output budget with it) get the higher default.
 */
const ADAPTIVE_THINKING_MODEL = /sonnet-5|opus-4-6|opus-4-7|opus-4-8|sonnet-4-6|fable|mythos/;

/**
 * Resolve the default per-call output-token ceiling for a model. The
 * operator-configured `ai_providers.config.maxOutputTokens` (threaded via
 * `ChatRunnerOptions.maxOutputTokens`) always wins over this default;
 * `CAELO_MAX_OUTPUT_TOKENS_DEFAULT` overrides the built-in defaults for
 * deployments that need a different floor without a /security/ai visit.
 */
export function resolveMaxOutputTokensDefault(model: string): number {
  const envRaw = process.env.CAELO_MAX_OUTPUT_TOKENS_DEFAULT;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 1024) return Math.floor(parsed);
    // Pre-1.0 fail-loud: a garbage env value must not silently fall back.
    console.error("[chat-runner] invalid CAELO_MAX_OUTPUT_TOKENS_DEFAULT — ignoring", { envRaw });
  }
  return ADAPTIVE_THINKING_MODEL.test(model)
    ? MAX_OUTPUT_TOKENS_ADAPTIVE_DEFAULT
    : MAX_OUTPUT_TOKENS_DEFAULT;
}

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
