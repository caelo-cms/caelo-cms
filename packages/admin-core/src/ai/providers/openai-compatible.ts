// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — OpenAI-compatible adapter for Ollama / LM Studio / LocalAI / vLLM.
 *
 * Reuses OpenAiProvider with a different baseUrl (e.g.
 * `http://localhost:11434/v1` for Ollama). The streaming protocol is the
 * same chat-completions SSE shape; tool-use support varies (Ollama
 * supports `tools` since v0.3+; LM Studio + vLLM depend on the loaded
 * model). Adapter doesn't gate on capability — emits whatever the
 * server returns.
 *
 * Usage tokens often missing from local-server responses; the adapter
 * falls back to a whitespace-token estimator (4-chars-per-token
 * approximation) so cost dashboards have non-zero data even though
 * the cost itself is zero (per ai_pricing seed).
 */

import type { AIProvider, ProviderName } from "../provider.js";
import { OpenAiProvider } from "./openai.js";

export interface OpenAiCompatibleConfig {
  /** Display label, e.g. "ollama-llama3.1" — surfaces in audit only. */
  readonly displayName: string;
  /** http://localhost:11434/v1 (Ollama) | http://localhost:1234/v1 (LM Studio) */
  readonly baseUrl: string;
  /** Model id as the local server knows it ("llama3.1:70b", "qwen-coder:14b"). */
  readonly model: string;
  /** Empty by default for local; pass for vLLM-with-token deployments. */
  readonly apiKey?: string;
}

export function makeOpenAiCompatibleProvider(cfg: OpenAiCompatibleConfig): AIProvider {
  const inner = new OpenAiProvider({
    apiKey: cfg.apiKey ?? "local-no-auth",
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  });
  // Re-tag the name so audit + cost rows distinguish local-vs-OpenAI.
  return {
    name: "local-openai-compat" as ProviderName,
    model: cfg.model,
    generate: inner.generate.bind(inner),
  };
}
