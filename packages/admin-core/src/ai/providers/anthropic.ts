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

import { anthropic as anthropicGlobal, createAnthropic } from "@ai-sdk/anthropic";
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

/**
 * v0.6.0 W2 — Anthropic Tool Search. When `toolSearch` is set to a
 * non-"off" value, the provider tags every caelo tool with
 * `providerOptions.anthropic.deferLoading: true` and injects the
 * matching `anthropic.tools.toolSearchBm25_20251119()` (or regex
 * variant) as a discovery surface. Claude calls the search tool
 * server-side, the SDK loads the matching deferred tools into
 * context, and Claude then emits a regular tool_use block — which
 * caelo's chat-runner handles via its existing ToolRegistry path.
 *
 * Anthropic released this with Opus 4.5 / Sonnet 4.5 (Nov 2025); newer
 * models inherit the capability. Off by default — operator opts in via
 * `CAELO_ANTHROPIC_TOOL_SEARCH={bm25|regex}` after confirming the
 * deployed model supports it.
 */
export type AnthropicToolSearchMode = "off" | "bm25" | "regex";

interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /**
   * v0.6.0 W2 — enable server-side Tool Search to drop per-turn
   * tool-description tokens. Off by default; opt-in via
   * `CAELO_ANTHROPIC_TOOL_SEARCH={bm25|regex}` env var.
   */
  readonly toolSearch?: AnthropicToolSearchMode;
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

/**
 * Claude 4.6+ models (Sonnet 5, Opus 4.6/4.7/4.8, Fable, Mythos) drop
 * the pre-4.6 sampling/thinking knobs: they reject `budget_tokens` AND
 * `temperature` with a 400 and take adaptive thinking instead. Older
 * models still accept both. Centralised here so every param that these
 * models deprecate is gated on ONE predicate.
 */
export function isAdaptiveModel(model: string): boolean {
  return /sonnet-5|opus-4-7|opus-4-8|opus-4-6|sonnet-4-6|fable|mythos/.test(model);
}

/**
 * Maps Caelo's provider-neutral thinking request onto the shape the
 * target Anthropic model accepts (see {@link isAdaptiveModel}).
 */
export function resolveThinkingOption(
  model: string,
  budgetTokens: number,
): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } {
  return isAdaptiveModel(model) ? { type: "adaptive" } : { type: "enabled", budgetTokens };
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #model: import("ai").LanguageModel;
  readonly #toolSearch: AnthropicToolSearchMode;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.#toolSearch = options.toolSearch ?? "off";
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
          thinking: resolveThinkingOption(this.model, input.thinking.budgetTokens),
        },
      };
    }
    // v0.6.0 W2 — Tool Search transform. Skip when (a) operator hasn't
    // opted in, OR (b) catalogue is below the threshold where Tool
    // Search wins (small catalogues lose more on the search-tool
    // overhead than they gain on description token reduction).
    // Threshold defaults to 10; tunable via
    // CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD env so deployments with
    // catalog growth or shrinkage can adjust without a code change.
    const thresholdRaw = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
    const threshold =
      thresholdRaw && Number.isFinite(Number(thresholdRaw))
        ? Math.max(1, Number(thresholdRaw))
        : 10;
    const useToolSearch = this.#toolSearch !== "off" && input.tools.length >= threshold;
    if (this.#toolSearch !== "off" && process.env.CAELO_DEBUG_TOOL_SEARCH === "1") {
      // Telemetry: log whether the transform actually engaged this turn,
      // so the operator can confirm BM25 fired (or didn't) without
      // tracing the wire-level Anthropic request.
      console.log("[anthropic.toolSearch]", {
        mode: this.#toolSearch,
        toolCount: input.tools.length,
        threshold,
        engaged: useToolSearch,
      });
    }
    const toolsTransform = useToolSearch
      ? (built: Record<string, unknown>): Record<string, unknown> => {
          // Mark every caelo tool as deferred so its description does
          // NOT ship in the first request body — Claude has to call
          // the search tool to discover it.
          for (const def of Object.values(built)) {
            if (def && typeof def === "object") {
              const existing = (def as { providerOptions?: Record<string, unknown> })
                .providerOptions;
              (def as { providerOptions?: Record<string, unknown> }).providerOptions = {
                ...(existing ?? {}),
                anthropic: {
                  ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
                  deferLoading: true,
                },
              };
            }
          }
          // Inject the search tool. Two algorithms: BM25 (natural-
          // language scoring — default; better when descriptions are
          // prose-y) and regex (exact-pattern; better when tools share
          // a strict naming convention).
          const searchTool =
            this.#toolSearch === "regex"
              ? anthropicGlobal.tools.toolSearchRegex_20251119()
              : anthropicGlobal.tools.toolSearchBm25_20251119();
          return { ...built, toolSearch: searchTool };
        }
      : undefined;
    // Claude 4.6+ models reject `temperature` with a 400 ("temperature
    // is deprecated for this model") — the request dies before the model
    // runs. Strip it for the adaptive class so a caller-supplied
    // temperature (e.g. the e2e harness's CAELO_CHAT_TEMPERATURE=0, or an
    // operator sampling setting) can't 400 the whole turn. Older Anthropic
    // models keep it.
    const effectiveInput =
      input.temperature !== undefined && isAdaptiveModel(this.model)
        ? { ...input, temperature: undefined }
        : input;
    yield* runSDKStream({
      model: this.#model,
      input: effectiveInput,
      systemAndMessages,
      extraOptions,
      ...(toolsTransform ? { toolsTransform } : {}),
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
