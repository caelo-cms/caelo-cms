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

import {
  generateObject,
  jsonSchema,
  type ModelMessage,
  NoObjectGeneratedError,
  streamText,
} from "ai";

import type {
  ChatMessageInput,
  GenerateInput,
  GenerateObjectResult,
  ProviderEvent,
} from "../provider.js";
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
  return messages.flatMap((m): ModelMessage[] => {
    // Option C (CLAUDE.md §12) — a replayed assistant turn carrying the
    // SDK's own `response.messages` is spliced back verbatim. The SDK
    // already assembled reasoning signatures + provider-tool pairing
    // correctly; rebuilding that from content/toolCalls/thinkingBlocks is
    // exactly what dropped the paired tool-search result and 400'd run-B6.
    // One history row expands to N ModelMessages here.
    if (m.sdkMessages && m.sdkMessages.length > 0) {
      return m.sdkMessages as ModelMessage[];
    }
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
        return [{ role: "user", content: parts as ModelMessage["content"] } as ModelMessage];
      }
      return [{ role: "user", content: m.content }];
    }
    if (m.role === "assistant") {
      const content: (
        | { type: "reasoning"; text: string; providerOptions?: unknown }
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
            providerExecuted?: boolean;
          }
        | {
            type: "tool-result";
            toolCallId: string;
            toolName: string;
            output: { type: "json"; value: unknown };
            providerExecuted: boolean;
          }
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
      // Anthropic Tool Search server_tool_use blocks are DELIBERATELY not
      // replayed (2026-07, run-B6). The docs' round-trip — pass the
      // server_tool_use + its tool_search_tool_result back unchanged so
      // discovered tools stay loaded — assumes you control the raw
      // Messages blocks. Through streamText's fullStream abstraction the
      // paired `tool_search_tool_result` does NOT surface reliably as a
      // consumable part (the wire SSE has it; the fullStream drops it),
      // so we'd emit a lone server_tool_use and Anthropic 400s:
      // "tool_search_tool_bm25 tool use ... without a corresponding
      // tool_search_tool_bm25_tool_result block" — killing the whole
      // turn. Dropping the block is always correct: the model simply
      // re-searches when it next needs a deferred tool (cheap; the
      // shipped chunks build searches ~never anyway). `serverToolCalls`
      // stays captured/persisted for audit + the wire log; it just isn't
      // sent back to the provider.
      for (const tc of m.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.name,
          input: tc.arguments,
        });
      }
      return [{ role: "assistant", content: content as ModelMessage["content"] } as ModelMessage];
    }
    // role === "tool"
    return [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId ?? "",
            toolName: "",
            output: { type: "text", value: m.content },
          },
        ],
      },
    ];
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
  let usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
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
          const name = (e.toolName as string | undefined) ?? "";
          const id = (e.toolCallId as string | undefined) ?? "";
          const args = typeof e.input === "string" ? safeJsonParse(e.input) : (e.input as unknown);
          // Provider-executed server tools (Anthropic Tool Search) ran
          // inside the request already. Forwarding them as regular
          // tool-calls sent them into chat-runner dispatch (`unknown
          // tool: tool_search_tool_bm25`, run V2) — but DROPPING them
          // is wrong too: the tool-search docs require the call/result
          // blocks to be replayed unchanged on subsequent requests, or
          // the model forgets its discovered tools and re-searches.
          // Emit a dedicated event the loop records without dispatch.
          // Name check as belt-and-braces: some SDK paths deliver the
          // server tool call without the flag.
          if (e.providerExecuted === true || name.startsWith("tool_search_tool")) {
            yield { kind: "server-tool-call", id, name, arguments: args };
            break;
          }
          yield { kind: "tool-call", id, name, arguments: args };
          break;
        }
        case "tool-result": {
          // Only provider-executed results ride the stream (client tool
          // results are produced by our own loop, never by the SDK).
          const name = (e.toolName as string | undefined) ?? "";
          if (e.providerExecuted === true || name.startsWith("tool_search_tool")) {
            const id = (e.toolCallId as string | undefined) ?? "";
            const result = "output" in e ? e.output : (e as { result?: unknown }).result;
            yield { kind: "server-tool-result", id, name, result };
          }
          break;
        }
        case "tool-approval-request": {
          // Slice 1 (SDK approval gate) — a gated tool was called; the SDK
          // paused before its execute. Carry the id + the pending call up so
          // the chat-runner can surface the in-chat Approve/Reject and stop
          // the turn (the paused state also rides response.messages/Option C).
          const approvalId = (e.approvalId as string | undefined) ?? "";
          const tc = e.toolCall as
            | { toolName?: string; toolCallId?: string; input?: unknown }
            | undefined;
          yield {
            kind: "tool-approval-request",
            approvalId,
            toolCallId: (tc?.toolCallId as string | undefined) ?? "",
            name: tc?.toolName ?? "",
            arguments: tc?.input,
          };
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
                inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
              }
            | undefined;
          if (u) {
            usage = {
              inputTokens: u.inputTokens ?? usage.inputTokens,
              outputTokens: u.outputTokens ?? usage.outputTokens,
              cachedTokens:
                u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? usage.cachedTokens,
              cacheCreationTokens:
                u.inputTokenDetails?.cacheWriteTokens ?? usage.cacheCreationTokens,
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
                inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
              }
            | undefined;
          // The cache WRITE count lives on the flat usage as
          // `inputTokenDetails.cacheWriteTokens` (@ai-sdk/anthropic 4.x,
          // present on both finish-step `usage` and finish `totalUsage`).
          // providerMetadata is undefined on the finish event, so do NOT
          // rely on it here.
          if (tu) {
            usage = {
              inputTokens: tu.inputTokens ?? usage.inputTokens,
              outputTokens: tu.outputTokens ?? usage.outputTokens,
              cachedTokens:
                tu.inputTokenDetails?.cacheReadTokens ?? tu.cachedInputTokens ?? usage.cachedTokens,
              cacheCreationTokens:
                tu.inputTokenDetails?.cacheWriteTokens ?? usage.cacheCreationTokens,
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
export function buildSDKTools(tools: GenerateInput["tools"]): Record<
  string,
  {
    description: string;
    inputSchema: ReturnType<typeof jsonSchema>;
    execute?: (input: unknown) => Promise<unknown>;
  }
> {
  const out: Record<
    string,
    {
      description: string;
      inputSchema: ReturnType<typeof jsonSchema>;
      execute?: (input: unknown) => Promise<unknown>;
    }
  > = {};
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
      // Slice 1 — gated tools are SDK-executed so `toolApproval` can pause
      // before the execute. Routine tools omit execute and come back as
      // client tool-calls for our loop to dispatch.
      ...(t.execute ? { execute: t.execute } : {}),
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
  // Slice 1 (SDK approval gate) — derive the toolApproval map from the tools
  // that declared approvalMode. `experimental_toolApprovalSecret`
  // cryptographically binds each approval request to this server so a forged
  // tool-approval-response can't be replayed (defense in depth alongside our
  // own Owner-scope check on resume). Only engaged when a gated tool is
  // actually in the catalogue for this turn.
  const toolApproval: Record<string, "user-approval"> = {};
  for (const t of input.tools) {
    if (t.approvalMode) toolApproval[t.name] = t.approvalMode;
  }
  const approvalSecret = process.env.CAELO_TOOL_APPROVAL_SECRET;
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
    ...(Object.keys(toolApproval).length > 0
      ? {
          toolApproval: toolApproval as Parameters<typeof streamText>[0]["toolApproval"],
          ...(approvalSecret
            ? ({ experimental_toolApprovalSecret: approvalSecret } as Record<string, unknown>)
            : {}),
        }
      : {}),
    maxOutputTokens: input.maxTokens ?? 32768,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(extraOptions ?? {}),
  });
  yield* translateSDKStream(result.fullStream);
  // Option C (2026-07) — after the stream drains, emit the SDK's
  // canonical assistant messages for this turn. The SDK assembles these
  // with provider-executed tool blocks + reasoning signatures + tool
  // pairing already correct; consumers persist + replay these instead of
  // rebuilding history from the event stream (CLAUDE.md §12). Best-effort:
  // if the response promise rejects (aborted turn, upstream error), skip
  // the event — the turn already surfaced its error/done through the
  // stream, and the caller falls back to its event-accumulated turn.
  try {
    const response = await result.response;
    yield { kind: "turn-messages", messages: response.messages };
  } catch {
    /* no canonical messages for an aborted/errored turn */
  }
}

/**
 * SDK-native structured output shared by all SDK-backed providers
 * (CLAUDE.md §12). Constrains the response to `rawJsonSchema` via
 * `generateObject` and returns the parsed object — no forced `submit_*`
 * tool, no arg-string parsing.
 *
 * Error contract mirrors the old stream-drain path so moduleize's repair
 * loop is unchanged:
 * - a schema-invalid / no-parseable-object result (`NoObjectGeneratedError`)
 *   returns `{ object: undefined }` — the caller re-prompts (repairable);
 * - any other throw (provider/API/network) propagates — NOT repairable.
 */
export async function runSDKGenerateObject(args: {
  model: import("ai").LanguageModel;
  modelId: string;
  systemAndMessages: { system?: string; messages: ModelMessage[] };
  rawJsonSchema: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  extraOptions?: Record<string, unknown>;
}): Promise<GenerateObjectResult> {
  const { model, modelId, systemAndMessages, rawJsonSchema, extraOptions } = args;
  try {
    const result = await generateObject({
      model,
      schema: jsonSchema(rawJsonSchema),
      allowSystemInMessages: true,
      ...(systemAndMessages.system !== undefined ? { system: systemAndMessages.system } : {}),
      messages: systemAndMessages.messages,
      maxOutputTokens: args.maxTokens ?? 8192,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
      ...(extraOptions ?? {}),
    });
    return {
      object: result.object,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      model: modelId,
    };
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e)) {
      // The model replied but the output didn't parse to the schema. This
      // is the repairable case — surface it as "no object" so the caller's
      // validate()+repair loop re-prompts, exactly as the old undefined
      // tool-args path did. Usage (if the SDK attached it) still counts.
      //
      // Log the ACTUAL reason so this is diagnosable — before, "no object"
      // was opaque and we couldn't tell WHY generateObject came back empty.
      // `cause` is the underlying JSON-parse / type-validation error; `text`
      // is the raw model output; `finishReason` distinguishes a length
      // cutoff / refusal from a genuine schema miss.
      const err = e as {
        cause?: unknown;
        text?: string;
        finishReason?: string;
      };
      console.error("[generateObject] NoObjectGenerated — model output did not parse to schema", {
        model: modelId,
        finishReason: err.finishReason ?? null,
        cause: err.cause instanceof Error ? err.cause.message : String(err.cause ?? "unknown"),
        rawTextHead: typeof err.text === "string" ? err.text.slice(0, 800) : null,
        rawTextLen: typeof err.text === "string" ? err.text.length : 0,
        inputTokens: e.usage?.inputTokens ?? 0,
        outputTokens: e.usage?.outputTokens ?? 0,
      });
      return {
        object: undefined,
        inputTokens: e.usage?.inputTokens ?? 0,
        outputTokens: e.usage?.outputTokens ?? 0,
        model: modelId,
      };
    }
    throw e;
  }
}
