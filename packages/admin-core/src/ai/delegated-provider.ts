// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #741 — the provider a tool sees when the AI work of a call belongs
 * to the calling agent (Power-MCP without the token's "Caelo may use its own
 * AI" opt-in). It keeps the real provider's identity (some tools read
 * `name`/`model`, e.g. to price an import) but refuses every generation, so
 * no tool can spend the install's AI on that path, whether or not it checks
 * `ToolContext.aiDelegated` first. Tools that hand back a work item check the
 * flag before they would generate; this guard catches any that do not.
 */

import type { AIProvider } from "./provider.js";

/** Message prefix of the refusal; shared with plugin-side `AiDelegated:` errors. */
export const AI_DELEGATED_PREFIX = "AiDelegated:";

function refusal(what: string): Error {
  return new Error(
    `${AI_DELEGATED_PREFIX} ${what} would run on the install's AI, but this call's AI work belongs to the calling agent (Power-MCP, issue #741). The tool must hand back a work item instead; this is a bug in the tool.`,
  );
}

/**
 * Wrap `provider` so every generation throws `AiDelegated:`.
 *
 * @param provider the install's provider, kept for its name and model
 */
export function delegatedProvider(provider: AIProvider): AIProvider {
  return {
    name: provider.name,
    model: provider.model,
    // biome-ignore lint/correctness/useYield: refuses before the first event by design
    async *generate() {
      throw refusal("a text generation");
    },
    async generateObject() {
      throw refusal("a structured generation");
    },
  };
}
