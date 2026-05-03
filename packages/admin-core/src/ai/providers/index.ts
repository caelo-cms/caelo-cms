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
import { AnthropicProvider } from "./anthropic.js";
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
}

export function makeProvider(config: ProviderConfig): AIProvider {
  switch (config.name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
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
