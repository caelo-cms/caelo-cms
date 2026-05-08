// SPDX-License-Identifier: MPL-2.0

/**
 * OpenAI provider — v0.2.73 uses the Vercel AI SDK
 * (`@ai-sdk/openai` + `streamText`) instead of a hand-rolled fetch +
 * SSE parser. Same public shape (`OpenAiProvider implements AIProvider`);
 * chat-runner doesn't notice the swap.
 *
 * Simpler than the Anthropic adapter: no cache control, no thinking
 * blocks. The shared `_sdk-shared.ts` translation layer handles the
 * streaming bookkeeping.
 *
 * Models: GPT-4o family is the production target. Forward-compat
 * with new model ids — accepts any string.
 */

import { createOpenAI } from "@ai-sdk/openai";

import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../provider.js";
import { runSDKStream, toSDKMessages } from "./_sdk-shared.js";

interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Test hook — pre-resolved LanguageModel instance. */
  readonly _modelOverride?: import("ai").LanguageModel;
}

export class OpenAiProvider implements AIProvider {
  readonly name: ProviderName = "openai";
  readonly model: string;
  readonly #model: import("ai").LanguageModel;

  constructor(options: OpenAiProviderOptions) {
    this.model = options.model;
    if (options._modelOverride) {
      this.#model = options._modelOverride;
      return;
    }
    const provider = createOpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
    this.#model = provider(options.model as Parameters<typeof provider>[0]);
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    // OpenAI doesn't have per-block cache control. Flatten the
    // system prompt into a single string.
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
