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
  /** v0.6.0 W2 — Anthropic-only Tool Search mode. Defaults to the
   * `CAELO_ANTHROPIC_TOOL_SEARCH` env (`off` / `bm25` / `regex`;
   * unset → `bm25`). Pass explicitly to override for a one-off
   * provider instance. */
  readonly anthropicToolSearch?: AnthropicToolSearchMode;
}

/**
 * v0.6.0 W2 — read the Tool Search mode from the environment.
 * Accepted values: "off", "bm25", "regex". Unset (or unknown) → "bm25":
 * the catalogue crossed 100 tools, so deferring the long tail behind
 * the search surface is the default; core workflow tools stay fully
 * loaded (tools/core-tools.ts) and the system prompt's tool playbook
 * tells the model which names to search for. Operators opt out with
 * `CAELO_ANTHROPIC_TOOL_SEARCH=off` (e.g. for models predating Tool
 * Search). Exported so tests can stub the env without mutating
 * process.env.
 */
export function resolveAnthropicToolSearchMode(
  override?: AnthropicToolSearchMode,
): AnthropicToolSearchMode {
  if (override) return override;
  const raw = (process.env.CAELO_ANTHROPIC_TOOL_SEARCH ?? "").toLowerCase().trim();
  if (raw === "off" || raw === "regex") return raw;
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
