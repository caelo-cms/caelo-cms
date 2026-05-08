// SPDX-License-Identifier: MPL-2.0

/**
 * Anthropic provider — v0.3.0+ uses the Vercel AI SDK
 * (`@ai-sdk/anthropic` + `ai`'s `streamText`) instead of a hand-rolled
 * fetch + SSE parser. Same public shape (`AnthropicProvider`
 * implements `AIProvider`); chat-runner doesn't notice the swap.
 *
 * What we get from the SDK:
 *  - Robust SSE parsing (no manual byte-level work).
 *  - Correct content-block accumulation including thinking blocks +
 *    cryptographic signatures (verified by v0.2.71 spike preflight).
 *  - Per-block cache control via `providerOptions.anthropic.cacheControl`.
 *  - Multimodal-ready (image content parts work in the same surface;
 *    v0.3.1 wires this up for screenshot tool results).
 *
 * What we DON'T use from the SDK: the auto-tool-loop. Caelo's
 * chat-runner manages the loop itself — snapshot emission, audit,
 * cost cap, subagent spawning, allowlist narrowing all happen
 * BETWEEN provider calls. We hand the SDK the tool catalog (so the
 * Anthropic API request includes it correctly) but never provide
 * `execute` callbacks; the SDK emits `tool-call` events and yields
 * control. chat-runner then dispatches via its own `tools.dispatch`.
 *
 * Provider-brand strings stay scoped to this file + the registry
 * factory; chat-runner sees only the abstract `ProviderEvent` union
 * (CLAUDE.md §4 — provider brand never surfaces in editor chat UI).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { jsonSchema, type ModelMessage, type SystemModelMessage, streamText } from "ai";

import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ProviderName,
} from "../provider.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /**
   * Test hook — pre-resolved LanguageModelV2 instance. When set, the
   * SDK's Anthropic-provider lookup is skipped and `streamText` runs
   * against this model directly. Production code never passes this;
   * the field exists for `MockLanguageModelV2`-driven unit tests.
   */
  readonly _modelOverride?: import("ai").LanguageModel;
}

/**
 * Map our ChatMessageInput → SDK ModelMessage[]. Thinking blocks
 * (with signatures) come FIRST on assistant turns — Anthropic's
 * signature verification on tool-use continuations relies on this
 * ordering, same constraint the hand-rolled adapter enforced.
 */
function toSDKMessages(messages: readonly ChatMessageInput[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "user") {
      // user content is plain text in current Caelo flows;
      // multimodal user messages (image attachments) land in v0.3.1
      // when ChatMessageInput.content gains content-parts support.
      return { role: "user", content: m.content };
    }
    if (m.role === "assistant") {
      const parts: Exclude<
        Parameters<(m: ModelMessage) => void>[0] & { role: "assistant" },
        never
      >["content"] = [];
      // v0.2.54 — thinking blocks first, with signatures preserved
      // via providerOptions.anthropic.signature. Confirmed by
      // v0.2.71 spike that the SDK serializes these back to
      // Anthropic's `thinking` content blocks correctly.
      const content: (
        | { type: "reasoning"; text: string; providerOptions?: unknown }
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      )[] = [];
      for (const tb of m.thinkingBlocks ?? []) {
        content.push({
          type: "reasoning",
          text: tb.thinking,
          providerOptions: { anthropic: { signature: tb.signature } },
        });
      }
      if (m.content.length > 0) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.name,
          input: tc.arguments,
        });
      }
      void parts;
      // The SDK's AssistantModelMessage type is broad enough to
      // accept this content array; the cast is a narrow shim around
      // the SDK's union typing.
      return { role: "assistant", content: content as ModelMessage["content"] } as ModelMessage;
    }
    // role === "tool" — the prior assistant's tool_use is being
    // answered. SDK shape: a tool message with tool-result parts.
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: m.toolCallId ?? "",
          toolName: "",
          output: { type: "text", value: m.content },
        },
      ],
    };
  });
}

/**
 * System prompt → SDK system shape. The SDK accepts a string OR (via
 * the messages array) SystemModelMessage entries with content parts;
 * per-part `providerOptions.anthropic.cacheControl` keeps the cache
 * prefix warm across turns when chips/skills change at the tail
 * (P5.2 #4 / v0.2.x).
 *
 * Returns either `{system: string}` for the simple case or
 * `{messages: [SystemModelMessage, ...input messages]}` when cache
 * control is required.
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
  // SystemModelMessage with anthropic.cacheControl. Non-cacheable
  // chunks ride along without cache control.
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
 * Translate SDK fullStream parts → Caelo's ProviderEvent union.
 * Reasoning parts map to thinking-delta + thinking-stop (signature
 * pulled from providerMetadata.anthropic). Tool-call parts arrive
 * already-assembled (input is the parsed JSON object). Finish-reason
 * mapping covers all four Anthropic stop reasons.
 *
 * The SDK only emits tool-error events when an `execute` callback is
 * provided, which we don't pass. Defensive branch included.
 */
async function* translateSDKStream(source: AsyncIterable<unknown>): AsyncIterable<ProviderEvent> {
  let usage: { inputTokens: number; outputTokens: number; cachedTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };
  // We accumulate the reasoning text from deltas because the SDK's
  // reasoning-end event doesn't include the full text on every
  // version; emit thinking-stop with what we accumulated.
  const reasoningById = new Map<string, string>();

  for await (const ev of source) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as { type: string; [k: string]: unknown };

    switch (e.type) {
      case "text-delta": {
        const text = (e.delta ?? e.text) as string | undefined;
        if (typeof text === "string" && text.length > 0) yield { kind: "text-delta", text };
        break;
      }
      case "reasoning-start": {
        const id = (e.id as string | undefined) ?? "";
        if (id) reasoningById.set(id, "");
        break;
      }
      case "reasoning-delta": {
        const id = (e.id as string | undefined) ?? "";
        const delta = (e.delta ?? e.text) as string | undefined;
        if (typeof delta === "string" && delta.length > 0) {
          if (id) {
            reasoningById.set(id, (reasoningById.get(id) ?? "") + delta);
          }
          yield { kind: "thinking-delta", text: delta };
        }
        break;
      }
      case "reasoning-end": {
        const id = (e.id as string | undefined) ?? "";
        const meta = (e.providerMetadata ?? e.providerOptions) as
          | { anthropic?: { signature?: string } }
          | undefined;
        const signature = meta?.anthropic?.signature ?? "";
        const accumulated = id ? (reasoningById.get(id) ?? "") : "";
        const text = (e.text as string | undefined) ?? accumulated;
        yield { kind: "thinking-stop", thinking: text, signature };
        if (id) reasoningById.delete(id);
        break;
      }
      case "tool-call": {
        const id = (e.toolCallId as string | undefined) ?? "";
        const name = (e.toolName as string | undefined) ?? "";
        const args = typeof e.input === "string" ? safeJsonParse(e.input) : (e.input as unknown);
        yield { kind: "tool-call", id, name, arguments: args };
        break;
      }
      case "finish-step": {
        // Per-step usage (one step per provider call in our flow).
        // We read it here so the outer `finish` event doesn't need
        // to carry usage; some SDK paths put it only on
        // finish-step, others mirror it on the outer finish via
        // `totalUsage`. Read both defensively.
        const u = e.usage as
          | { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
          | undefined;
        if (u) {
          usage = {
            inputTokens: u.inputTokens ?? usage.inputTokens,
            outputTokens: u.outputTokens ?? usage.outputTokens,
            cachedTokens: u.cachedInputTokens ?? usage.cachedTokens,
          };
        }
        break;
      }
      case "finish": {
        // The outer finish event. Some SDK versions carry usage on
        // `totalUsage` here (sum across steps) while finish-step
        // events have per-step `usage`. Use whichever is present;
        // we've already accumulated from finish-step above.
        const tu = (e.totalUsage ?? e.usage) as
          | { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
          | undefined;
        if (tu) {
          usage = {
            inputTokens: tu.inputTokens ?? usage.inputTokens,
            outputTokens: tu.outputTokens ?? usage.outputTokens,
            cachedTokens: tu.cachedInputTokens ?? usage.cachedTokens,
          };
        }
        yield { kind: "usage", ...usage };
        const reason = e.finishReason as string | undefined;
        yield {
          kind: "done",
          stopReason:
            reason === "stop"
              ? "end_turn"
              : reason === "tool-calls"
                ? "tool_use"
                : reason === "length"
                  ? "max_tokens"
                  : "error",
        };
        break;
      }
      case "error": {
        const errVal = e.error as unknown;
        const message =
          errVal instanceof Error
            ? errVal.message
            : typeof errVal === "string"
              ? errVal
              : "provider error";
        yield { kind: "error", message };
        yield { kind: "done", stopReason: "error" };
        break;
      }
      // text-start / text-end / tool-input-* / tool-error / start-step
      // / finish-step are intentionally ignored — our ProviderEvent
      // union doesn't expose these and chat-runner doesn't need them.
    }
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __parse_error: s };
  }
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    if (options._modelOverride) {
      this.#model = options._modelOverride as ReturnType<ReturnType<typeof createAnthropic>>;
      return;
    }
    const provider = createAnthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl && options.baseUrl !== DEFAULT_BASE_URL
        ? { baseURL: options.baseUrl }
        : {}),
    });
    // Cast through `string` to allow forward-compat with new
    // Claude model ids without a Caelo redeploy.
    this.#model = provider(options.model as Parameters<typeof provider>[0]);
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    // Tools — pass schema only; no execute. SDK surfaces tool-call
    // events and yields control to chat-runner for dispatch.
    const tools: Record<string, ReturnType<typeof toolDef>> = {};
    for (const t of input.tools) {
      tools[t.name] = toolDef(t.description, t.inputSchema);
    }

    const { system, messages } = buildSystemAndMessages(
      input.systemPrompt,
      input.cacheBreakpoints,
      input.messages,
    );

    const result = streamText({
      model: this.#model,
      ...(system !== undefined ? { system } : {}),
      messages,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      // v0.2.54 — 32k default for modern Claude models. Operator
      // tunes per-provider via /security/ai (1024-200000).
      maxOutputTokens: input.maxTokens ?? 32768,
      ...(input.thinking
        ? {
            providerOptions: {
              anthropic: {
                thinking: {
                  type: "enabled",
                  budgetTokens: input.thinking.budgetTokens,
                },
              },
            },
          }
        : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });

    yield* translateSDKStream(result.fullStream);
  }
}

/**
 * SDK tool wrapper — just shape, no execute. The chat-runner
 * dispatches tools via its own `tools.dispatch`, so the SDK only
 * needs the catalog for the Anthropic API request.
 */
function toolDef(description: string, inputSchema: Record<string, unknown>) {
  return {
    description,
    inputSchema: jsonSchema(inputSchema),
  };
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
