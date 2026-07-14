// SPDX-License-Identifier: MPL-2.0

/**
 * Provider factory keyed by name. P5 ships only the Anthropic adapter
 * + a fixture-replay implementation for tests; P16 adds OpenAI, Google,
 * local OpenAI-compatible.
 *
 * The API key is passed in (never read from a global) so the secrets-
 * manager abstraction in P14 can plug in without touching this file.
 */

import type { AIProvider, ProviderName } from "../provider.js";
import { AnthropicProvider, type AnthropicToolSearchMode } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAiProvider } from "./openai.js";
import { makeOpenAiCompatibleProvider } from "./openai-compatible.js";

export interface ProviderConfig {
  readonly name: ProviderName;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Display label — only used by openai-compatible to distinguish
   *  multiple local backends ("ollama-llama3.1" vs "lm-studio-qwen"). */
  readonly displayName?: string;
  /** v0.6.0 W2 — Anthropic-only Tool Search opt-in. Defaults to
   * `CAELO_ANTHROPIC_TOOL_SEARCH` env (`bm25` / `regex` / unset). Pass
   * explicitly to override for a one-off provider instance. */
  readonly anthropicToolSearch?: AnthropicToolSearchMode;
}

/**
 * v0.6.0 W2 — read the Tool Search opt-in from the environment.
 * Accepted values: "bm25", "regex". Anything else (or unset) → off.
 * Exported so tests can stub the env without mutating process.env.
 */
export function resolveAnthropicToolSearchMode(
  override?: AnthropicToolSearchMode,
): AnthropicToolSearchMode {
  if (override) return override;
  const raw = (process.env.CAELO_ANTHROPIC_TOOL_SEARCH ?? "").toLowerCase().trim();
  if (raw === "bm25" || raw === "regex" || raw === "off") return raw;
  // Tool-Search is ON by default (opt out with CAELO_ANTHROPIC_TOOL_SEARCH=off).
  // It defers the ~38k-token catalogue behind a server-side search — measured
  // real input ~104k→43k/call (run-logs/token-efficiency-analysis.md). The
  // empty-response regression the e2e first caught (a turn whose only output is
  // the server-side toolSearch call) is fixed at the root in _sdk-shared.ts:
  // a >1 step budget when a provider-executed tool is present lets the model
  // continue past the search to its real tool-call in the same call.
  return "bm25";
}

export function makeProvider(config: ProviderConfig): AIProvider {
  switch (config.name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        toolSearch: resolveAnthropicToolSearchMode(config.anthropicToolSearch),
      });
    case "openai":
      return new OpenAiProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case "google":
      return new GeminiProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case "local-openai-compat":
      return makeOpenAiCompatibleProvider({
        displayName: config.displayName ?? "openai-compatible",
        baseUrl: config.baseUrl ?? "http://localhost:11434/v1",
        model: config.model,
        apiKey: config.apiKey,
      });
  }
}

export { AnthropicProvider, FixtureProvider, MultiFixtureProvider } from "./anthropic.js";
export { GeminiProvider } from "./gemini.js";
export { OpenAiProvider } from "./openai.js";
export { makeOpenAiCompatibleProvider } from "./openai-compatible.js";
export {
  clearAllTestProviders,
  clearTestProvider,
  isTestRegistryEnabled,
  registerTestProvider,
  resolveTestProvider,
} from "./test-registry.js";
