// SPDX-License-Identifier: MPL-2.0

/**
 * Shared helpers for SDK-backed providers. v0.2.72 introduced the
 * Anthropic provider rewrite on `@ai-sdk/anthropic` + `streamText`;
 * v0.2.73 ports the same shape to OpenAI / Gemini /
 * local-OpenAI-compat. The translation layer (SDK fullStream parts →
 * Caelo's `ProviderEvent` union) is provider-agnostic, so it lives
 * here and each provider file is a ~50 LOC wrapper around the SDK
 * factory.
 *
 * What's NOT here:
 * - Anthropic-specific `cacheControl` system-prompt encoding (lives
 *   in anthropic.ts because OpenAI/Gemini don't support it the same
 *   way).
 * - Anthropic-specific `thinking` body parameter (anthropic.ts).
 *
 * The chat-runner sees only the abstract `ProviderEvent` union — no
 * provider-brand strings cross this boundary (CLAUDE.md §4).
 */

import { jsonSchema, type ModelMessage, streamText } from "ai";

import type { ChatMessageInput, GenerateInput, ProviderEvent } from "../provider.js";
import { normalizeToolArgs } from "../tools/normalize-args.js";

/**
 * Map our ChatMessageInput → SDK ModelMessage[]. Same shape every
 * SDK-backed provider uses. Thinking blocks (Anthropic-only) are
 * mapped to `reasoning` content parts with signature in
 * `providerOptions.anthropic.signature` — providers that don't
 * understand them ignore the part transparently (the SDK's
 * Anthropic-specific provider options don't fire on OpenAI/Gemini
 * paths).
 */
export function toSDKMessages(messages: readonly ChatMessageInput[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "user") {
      // v0.3.0 — multimodal user messages. When a prior tool result
      // delivered non-text content (e.g. screenshot_page returned a
      // PNG), chat-runner builds a follow-up user message with the
      // image attached via `additionalContent`. The SDK accepts an
      // array of {type:"text"} | {type:"image"} parts.
      if (m.additionalContent && m.additionalContent.length > 0) {
        const parts: (
          | { type: "text"; text: string }
          | { type: "image"; image: string; mediaType: string }
        )[] = [];
        if (m.content.length > 0) parts.push({ type: "text", text: m.content });
        for (const c of m.additionalContent) {
          if (c.type === "text") parts.push({ type: "text", text: c.text });
          else if (c.type === "image") {
            // SDK accepts data URL for the `image` field; mediaType
            // is informational so the provider knows the format.
            parts.push({
              type: "image",
              image: `data:${c.mediaType};base64,${c.base64}`,
              mediaType: c.mediaType,
            });
          }
        }
        return { role: "user", content: parts as ModelMessage["content"] } as ModelMessage;
      }
      return { role: "user", content: m.content };
    }
    if (m.role === "assistant") {
      const content: (
        | { type: "reasoning"; text: string; providerOptions?: unknown }
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      )[] = [];
      // Thinking blocks first — Anthropic's signature verification
      // requires this ordering. Other providers ignore the
      // providerOptions.anthropic key.
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
      return { role: "assistant", content: content as ModelMessage["content"] } as ModelMessage;
    }
    // role === "tool"
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
 * Translate SDK fullStream parts → Caelo's ProviderEvent union.
 * Identical for every SDK-backed provider — the SDK normalizes
 * provider-specific shapes into a uniform stream.
 */
export async function* translateSDKStream(
  source: AsyncIterable<unknown>,
): AsyncIterable<ProviderEvent> {
  let usage: { inputTokens: number; outputTokens: number; cachedTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };
  // Reasoning text accumulates across deltas; emit at reasoning-end.
  const reasoningById = new Map<string, string>();

  // v0.5.9 — track whether a terminal `done` event was yielded. If the
  // underlying SDK stream ends without a `finish` or `error` part
  // (proxy cut HTTP/2 cleanly with FIN/RST, model API closed the
  // stream without a terminator, etc.) the for-await loop exits with
  // no `done` yielded — downstream chat-runner falls through to an
  // empty turn and the user sees a silent completion. The finally
  // block below emits a synthetic terminal pair so every stream-end
  // path produces an explicit signal.
  let yieldedDone = false;

  try {
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
            if (id) reasoningById.set(id, (reasoningById.get(id) ?? "") + delta);
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
          // SDK 6 LanguageModelUsage shape: flat inputTokens/outputTokens
          // counters with cache info nested under inputTokenDetails.
          // (SDK 5 had a flat `cachedInputTokens` field.) Read both for
          // forward-compat with future shape changes.
          const u = e.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cachedInputTokens?: number;
                inputTokenDetails?: { cacheReadTokens?: number };
              }
            | undefined;
          if (u) {
            usage = {
              inputTokens: u.inputTokens ?? usage.inputTokens,
              outputTokens: u.outputTokens ?? usage.outputTokens,
              cachedTokens:
                u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? usage.cachedTokens,
            };
          }
          break;
        }
        case "finish": {
          const tu = (e.totalUsage ?? e.usage) as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cachedInputTokens?: number;
                inputTokenDetails?: { cacheReadTokens?: number };
              }
            | undefined;
          if (tu) {
            usage = {
              inputTokens: tu.inputTokens ?? usage.inputTokens,
              outputTokens: tu.outputTokens ?? usage.outputTokens,
              cachedTokens:
                tu.inputTokenDetails?.cacheReadTokens ?? tu.cachedInputTokens ?? usage.cachedTokens,
            };
          }
          yield { kind: "usage", ...usage };
          const reason = e.finishReason as string | undefined;
          // v0.10.17 — diagnostic capture for empty-response root-cause
          // hunt. When the model emits 0 text + 0 tools + 0 thinking
          // BUT the stream still yields a finish event, the answer
          // for "why was the response empty?" lives in providerMetadata
          // (Anthropic's raw stop_reason: "refusal" | "pause_turn" |
          // "end_turn" | …), the SDK's `warnings` array, and any
          // response.body. Capture all of them at the finish site —
          // chat-runner reads stoppingDiagnostics from `done` and
          // logs them when the empty-response branch fires.
          const eventAny = e as {
            finishReason?: string;
            warnings?: unknown;
            providerMetadata?: unknown;
            response?: { body?: unknown; messageId?: string; modelId?: string };
          };
          const stoppingDiagnostics = {
            rawFinishReason: eventAny.finishReason ?? null,
            warnings: eventAny.warnings ?? null,
            providerMetadata: eventAny.providerMetadata ?? null,
            responseMessageId: eventAny.response?.messageId ?? null,
            responseModelId: eventAny.response?.modelId ?? null,
          };
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
            stoppingDiagnostics,
          } as ProviderEvent;
          yieldedDone = true;
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
          yieldedDone = true;
          break;
        }
      }
    }
  } finally {
    // v0.5.9 — every exit path emits a terminal pair. If the source
    // ended without a `finish` or `error` part the chat-runner would
    // otherwise see the inner for-await exit with no `done`, then
    // fall through to an empty-turn no-op. Emit synthetic events so
    // downstream sees explicit failure.
    if (!yieldedDone) {
      console.error("[provider stream] ended without finish event", {
        usageInput: usage.inputTokens,
        usageOutput: usage.outputTokens,
      });
      yield {
        kind: "error",
        message:
          "Provider stream ended without a finish event — likely an upstream proxy closed the connection. Retry the message.",
      };
      yield { kind: "done", stopReason: "error" };
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

/**
 * Build the streamText({tools}) parameter from Caelo's tool catalog.
 * Schema-only (no execute) — chat-runner dispatches via its own
 * `tools.dispatch` so the SDK doesn't run the tool loop.
 *
 * issue #245 root cause — each tool schema carries a `validate` callback.
 * The AI SDK parses a tool call's raw argument text via `safeParseJSON`,
 * then runs the schema's `validate`; when `validate` is absent (as it was
 * before this change, since we handed the SDK a bare `jsonSchema(...)`) the
 * SDK short-circuits to `{ success: true, value }` and passes the model's
 * raw `JSON.parse` output straight through as the tool-call `.input`. So a
 * turn where the model emits a quoted scalar (`"position":"2"`) or a
 * JSON-encoded object-in-a-string (`"values":"{…}"`) delivered that
 * stringified value unchanged to dispatch, where the strict Zod parse
 * rejected it (findings F11/F12/F17). Attaching a `validate` that runs the
 * inputSchema-guided coercion (`normalizeToolArgs`) makes the SDK repair the
 * encoding at parse time, so args reach dispatch already correctly typed.
 * The dispatch-time `normalizeToolArgs` stays as idempotent defense-in-depth
 * (it re-runs on already-coerced args as a no-op). The coercion never
 * rejects — the Zod schema at dispatch remains the sole strict authority,
 * so it still produces the AI-actionable error message on genuinely invalid
 * input.
 */
export function buildSDKTools(
  tools: GenerateInput["tools"],
): Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> {
  const out: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> =
    {};
  for (const t of tools) {
    const schema = t.inputSchema;
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(schema, {
        validate: (value: unknown) => ({
          success: true,
          value: normalizeToolArgs(value, schema).args,
        }),
      }),
    };
  }
  return out;
}

/**
 * Run a streamText call configured for ONE provider call (no
 * auto-loop). All four SDK-backed providers funnel through this
 * helper for the actual streaming + translation. The
 * `extraOptions` argument carries provider-specific bits
 * (Anthropic's `providerOptions.anthropic.thinking`, OpenAI's
 * `providerOptions.openai.*`, etc.).
 *
 * v0.6.0 W2 — `toolsTransform` lets a provider rewrite the tools
 * dictionary before it ships to streamText. Anthropic uses this to
 * (a) tag every caelo-defined tool with
 * `providerOptions.anthropic.deferLoading: true` and (b) inject
 * `anthropic.tools.toolSearchBm25_20251119()` as the discovery
 * surface. Other providers leave it undefined.
 */
export async function* runSDKStream(args: {
  model: import("ai").LanguageModel;
  input: GenerateInput;
  /**
   * Either a flat string system prompt OR pre-built messages with
   * SystemModelMessage entries up front (Anthropic uses the latter
   * for cache-control, others use the former).
   */
  systemAndMessages: { system?: string; messages: ModelMessage[] };
  extraOptions?: Record<string, unknown>;
  /**
   * v0.6.0 W2 — provider-specific transformer applied to the tools
   * dictionary before streamText runs. Receives the built tools
   * keyed by name (the shape produced by `buildSDKTools`) and
   * returns a possibly-augmented dictionary that may contain
   * additional named entries (e.g. provider-defined tools like
   * Anthropic's `toolSearch`).
   */
  toolsTransform?: (built: Record<string, unknown>) => Record<string, unknown>;
}): AsyncIterable<ProviderEvent> {
  const { model, input, systemAndMessages, extraOptions, toolsTransform } = args;
  const builtTools = buildSDKTools(input.tools) as Record<string, unknown>;
  const sdkTools = toolsTransform ? toolsTransform(builtTools) : builtTools;
  const result = streamText({
    model,
    // AI SDK 7 made system-in-messages a hard error by default. Our Anthropic
    // adapter deliberately puts each cacheable system CHUNK in the messages
    // array as a `role:"system"` message with per-part `cacheControl` — that is
    // exactly the multi-breakpoint prompt-caching shape the @ai-sdk/anthropic
    // docs still support, and it's how we keep the ~93% cache hit across turns.
    // Opt back in so the streamed turn doesn't throw AI_InvalidPromptError.
    allowSystemInMessages: true,
    ...(systemAndMessages.system !== undefined ? { system: systemAndMessages.system } : {}),
    messages: systemAndMessages.messages,
    ...(Object.keys(sdkTools).length > 0
      ? { tools: sdkTools as Parameters<typeof streamText>[0]["tools"] }
      : {}),
    maxOutputTokens: input.maxTokens ?? 32768,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(extraOptions ?? {}),
  });
  yield* translateSDKStream(result.fullStream);
}
