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
import { AnthropicProvider, FixtureProvider } from "./anthropic.js";

export interface ProviderConfig {
  readonly name: ProviderName;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export function makeProvider(config: ProviderConfig): AIProvider {
  switch (config.name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    default:
      throw new Error(`provider ${config.name} not yet implemented (P16)`);
  }
}

export { AnthropicProvider, FixtureProvider };
