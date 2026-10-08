// SPDX-License-Identifier: MPL-2.0

/**
 * Adapter from admin-core's event-streaming AIProvider to the plugin
 * host's single-shot `complete()` shape (`ctx.ai.complete`). Drains the
 * stream, accumulates text + usage, and reports the provider + model the
 * call ran on so the host can record it in `ai_calls` against the plugin.
 *
 * The provider is resolved per call, so a freshly saved key or model
 * applies without a restart. The call's declared `purpose` selects the
 * Owner's per-purpose model (#593, `getActiveProviderForPurpose`); with
 * none stored it runs on the chat model. No provider configured →
 * `complete()` throws, and the plugin host surfaces that to the plugin.
 */

import type { AIProvider as PluginHostAIProvider } from "@caelo-cms/plugin-host";
import { getActiveProviderForPurpose } from "./provider-resolver.js";

/** Build the `aiProvider` the plugin host's `ctx.ai.complete` calls. */
export function makePluginTextProvider(): PluginHostAIProvider {
  return {
    complete: async (opts) => {
      const resolved = await getActiveProviderForPurpose(opts.purpose);
      if (!resolved) {
        throw new Error("AI provider not configured — Owner must visit /security/ai");
      }
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let cacheCreationTokens = 0;
      const stream = resolved.provider.generate({
        systemPrompt: opts.system,
        messages: opts.messages,
        tools: [],
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      for await (const event of stream) {
        if (event.kind === "text-delta") text += event.text;
        else if (event.kind === "usage") {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          cachedTokens = event.cachedTokens;
          cacheCreationTokens = event.cacheCreationTokens ?? 0;
        } else if (event.kind === "error") {
          throw new Error(`provider error: ${event.message}`);
        }
      }
      return {
        text,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheCreationTokens,
        provider: resolved.providerName,
        model: resolved.model,
      };
    },
  };
}
