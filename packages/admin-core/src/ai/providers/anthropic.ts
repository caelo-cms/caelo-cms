// SPDX-License-Identifier: MPL-2.0

/**
 * Anthropic provider — v0.3.0+ uses the Vercel AI SDK
 * (`@ai-sdk/anthropic` + `ai`'s `streamText`) instead of a hand-rolled
 * fetch + SSE parser. Same public shape (`AnthropicProvider`
 * implements `AIProvider`); chat-runner doesn't notice the swap.
 *
 * What's Anthropic-specific in this file (vs. the shared SDK code in
 * `_sdk-shared.ts`):
 *   - The `cacheControl` system-prompt encoding for ephemeral
 *     prompt-cache breakpoints — only Anthropic supports per-message
 *     cache control through `providerOptions.anthropic.cacheControl`.
 *   - The `thinking` body parameter for extended thinking — only
 *     Anthropic supports the `{type:"enabled", budgetTokens}` shape.
 *   - The `createAnthropic` factory + `_modelOverride` test hook.
 *
 * What we DON'T use from the SDK: the auto-tool-loop. Caelo's
 * chat-runner manages snapshot emission, audit, cost cap, subagent
 * spawning, allowlist narrowing — all between provider calls. We
 * hand the SDK the tool catalog (so the API request includes it
 * correctly) but never provide `execute` callbacks; the SDK emits
 * `tool-call` events and yields control to chat-runner.
 *
 * Provider-brand strings stay scoped to this file + the registry
 * factory; chat-runner sees only the abstract `ProviderEvent` union
 * (CLAUDE.md §4).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage, SystemModelMessage } from "ai";

import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ProviderName,
} from "../provider.js";
import { runSDKStream, toSDKMessages } from "./_sdk-shared.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /**
   * Test hook — pre-resolved LanguageModel instance. When set, the
   * SDK's Anthropic-provider lookup is skipped and `streamText` runs
   * against this model directly. Production code never passes this.
   */
  readonly _modelOverride?: import("ai").LanguageModel;
}

/**
 * System prompt → SDK system shape. The SDK accepts a string OR
 * (via the messages array) `SystemModelMessage` entries with
 * per-part `providerOptions.anthropic.cacheControl` — that's how we
 * keep the cache prefix warm across turns when chips/skills change
 * at the tail (P5.2 #4 / v0.2.x).
 */
function buildSystemAndMessages(
  prompt: GenerateInput["systemPrompt"],
  cacheBreakpoints: GenerateInput["cacheBreakpoints"],
  inputMessages: readonly ChatMessageInput[],
): { system?: string; messages: ModelMessage[] } {
  const userMessages = toSDKMessages(inputMessages);
  if (typeof prompt === "string") {
    if (cacheBreakpoints?.includes("system")) {
      const sysMsg: SystemModelMessage = {
        role: "system",
        content: prompt,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      };
      return { messages: [sysMsg, ...userMessages] };
    }
    return { system: prompt, messages: userMessages };
  }
  // Chunked prompt — each cacheable chunk gets its own
  // SystemModelMessage with anthropic.cacheControl.
  const sysMessages: SystemModelMessage[] = prompt.map((c) => ({
    role: "system",
    content: c.body,
    ...(c.cacheable
      ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      : {}),
  }));
  return { messages: [...sysMessages, ...userMessages] };
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #model: import("ai").LanguageModel;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    if (options._modelOverride) {
      this.#model = options._modelOverride;
      return;
    }
    const provider = createAnthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl && options.baseUrl !== DEFAULT_BASE_URL
        ? { baseURL: options.baseUrl }
        : {}),
    });
    // Cast through `string` for forward-compat with new model ids.
    this.#model = provider(options.model as Parameters<typeof provider>[0]);
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    const systemAndMessages = buildSystemAndMessages(
      input.systemPrompt,
      input.cacheBreakpoints,
      input.messages,
    );
    // v0.2.54 — extended thinking. Anthropic-specific provider
    // option; OpenAI/Gemini don't have an equivalent body param.
    const extraOptions: Record<string, unknown> = {};
    if (input.thinking) {
      extraOptions.providerOptions = {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: input.thinking.budgetTokens,
          },
        },
      };
    }
    yield* runSDKStream({
      model: this.#model,
      input,
      systemAndMessages,
      extraOptions,
    });
  }
}

/**
 * Fixture-driven provider for tests. Replays a pre-recorded ProviderEvent
 * stream so PR CI can exercise the chat / tool-dispatch path without
 * hitting the live API. Real-provider tests (gated behind `bun run
 * test:live`) use AnthropicProvider directly.
 */
export class FixtureProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #events: readonly ProviderEvent[];

  constructor(events: readonly ProviderEvent[], model = "claude-opus-4-7") {
    this.#events = events;
    this.model = model;
  }

  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    for (const e of this.#events) yield e;
  }
}

/**
 * Multi-loop fixture for tool-use → continuation flows. The chat runner
 * calls `generate()` once per loop iteration: first call returns the
 * queue's first sub-array (typically ending in stopReason `tool_use`),
 * second call returns the continuation after the tool result lands. Past
 * the queue, returns a single end_turn event so the runner exits cleanly.
 */
export class MultiFixtureProvider extends FixtureProvider {
  readonly #queue: readonly (readonly ProviderEvent[])[];
  #idx = 0;

  constructor(queue: readonly (readonly ProviderEvent[])[], model = "claude-opus-4-7") {
    super([], model);
    this.#queue = queue;
  }

  override async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    const events = this.#queue[this.#idx] ?? [
      { kind: "done", stopReason: "end_turn" } as ProviderEvent,
    ];
    this.#idx += 1;
    for (const e of events) yield e;
  }
}
