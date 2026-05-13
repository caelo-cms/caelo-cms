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
 */
export function buildSDKTools(
  tools: GenerateInput["tools"],
): Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> {
  const out: Record<string, { description: string; inputSchema: ReturnType<typeof jsonSchema> }> =
    {};
  for (const t of tools) {
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
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
}): AsyncIterable<ProviderEvent> {
  const { model, input, systemAndMessages, extraOptions } = args;
  const sdkTools = buildSDKTools(input.tools);
  const result = streamText({
    model,
    ...(systemAndMessages.system !== undefined ? { system: systemAndMessages.system } : {}),
    messages: systemAndMessages.messages,
    ...(Object.keys(sdkTools).length > 0 ? { tools: sdkTools } : {}),
    maxOutputTokens: input.maxTokens ?? 32768,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(extraOptions ?? {}),
  });
  yield* translateSDKStream(result.fullStream);
}
