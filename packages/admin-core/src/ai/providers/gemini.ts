// SPDX-License-Identifier: MPL-2.0

/**
 * Google Gemini provider — v0.2.73 uses the Vercel AI SDK
 * (`@ai-sdk/google` + `streamText`) instead of a hand-rolled fetch +
 * SSE parser. Same public shape (`GeminiProvider implements AIProvider`);
 * chat-runner doesn't notice the swap.
 *
 * Caelo uses the Generative Language API (the consumer-facing
 * `generativelanguage.googleapis.com` surface, NOT Vertex AI). The
 * `@ai-sdk/google` factory wraps that endpoint by default.
 *
 * Models: Gemini 2.5-pro / 2.5-flash production targets. Forward-compat
 * — accepts any string model id.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";

import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../provider.js";
import { runSDKStream, toSDKMessages } from "./_sdk-shared.js";

interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Test hook — pre-resolved LanguageModel instance. */
  readonly _modelOverride?: import("ai").LanguageModel;
}

export class GeminiProvider implements AIProvider {
  readonly name: ProviderName = "google";
  readonly model: string;
  readonly #model: import("ai").LanguageModel;

  constructor(options: GeminiProviderOptions) {
    this.model = options.model;
    if (options._modelOverride) {
      this.#model = options._modelOverride;
      return;
    }
    const provider = createGoogleGenerativeAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
    this.#model = provider(options.model as Parameters<typeof provider>[0]);
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    // Gemini doesn't have per-block cache control. Flatten the
    // system prompt to a single string.
    const system =
      typeof input.systemPrompt === "string"
        ? input.systemPrompt
        : input.systemPrompt.map((c) => c.body).join("\n\n");
    yield* runSDKStream({
      model: this.#model,
      input,
      systemAndMessages: { system, messages: toSDKMessages(input.messages) },
    });
  }
}
