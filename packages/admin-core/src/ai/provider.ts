// SPDX-License-Identifier: MPL-2.0

/**
 * Provider abstraction for the AI layer. The chat surface (ops, UI, tool
 * dispatch) treats the provider as opaque — no provider-brand strings
 * leak past this boundary, satisfying the §4 "provider brand never
 * surfaces in editor chat UI" rule.
 *
 * `generate` is an async iterable of structured `ProviderEvent`s so the
 * caller can stream tokens to the client over SSE while accumulating
 * tool calls and usage. All provider-specific SDK types stop at the
 * `providers/anthropic.ts` (and later `providers/openai.ts`, etc.)
 * adapter — this file is provider-agnostic on purpose.
 */

export type ProviderName = "anthropic" | "openai" | "google" | "local-openai-compat";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema describing the tool input. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Tool-search hint: when a provider defers tool loading behind a
   * search surface (Anthropic Tool Search), tools flagged here keep
   * their full definition in every request. Set from CORE_TOOL_NAMES
   * (the everyday workflow tools named in the system prompt's tool
   * playbook) so the model can call them without a discovery
   * round-trip. Providers without deferred loading ignore the flag.
   */
  readonly alwaysLoaded?: boolean;
}

export interface ChatMessageInput {
  readonly role: "user" | "assistant" | "tool";
  /**
   * Plain text in the common case. v0.3.0 — when a tool result delivered
   * non-text content (e.g. screenshot_page returns a PNG), the chat-runner
   * builds a follow-up `user` message with structured `additionalContent`
   * (image parts) alongside the text content. The SDK-mapper inlines
   * the image into the next provider call as a multimodal user message;
   * Anthropic + GPT-4o + Gemini all accept image content blocks via
   * the AI SDK's normalized content shape.
   */
  readonly content: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  /** Set when role === "tool" — references the assistant's tool_use id. */
  readonly toolCallId?: string;
  /**
   * v0.3.0 — optional non-text content parts. Currently only image
   * parts are produced (screenshot_page tool); future tools that emit
   * audio / file attachments would extend the union here.
   *
   * Placement: each part rides ALONGSIDE `content` on the same
   * message. The SDK-mapper composes them into a multimodal content
   * array. The chat-runner does NOT persist these to chat_messages
   * today — they're runtime-only (operator's screenshot is fed into
   * the next provider call but not stored across sessions).
   */
  readonly additionalContent?: readonly ContentPart[];
  /**
   * v0.2.54 — extended-thinking blocks emitted by the model on a prior
   * assistant turn. When the chat-runner re-prompts after tool_results,
   * these MUST be replayed verbatim (text + cryptographic signature)
   * before the text + tool_use blocks; Anthropic uses the signature to
   * verify reasoning continuity and rejects stripped thinking with
   * HTTP 400. Only meaningful for role === "assistant"; ignored
   * otherwise. Empty array OR undefined = no thinking blocks.
   */
  readonly thinkingBlocks?: readonly ProviderThinkingBlock[];
  /**
   * Provider-executed (server) tool calls on a prior assistant turn —
   * Anthropic Tool Search. Replayed as `server_tool_use` +
   * `tool_search_tool_result` blocks (in order, BEFORE the client
   * tool_use blocks) so discovered tools stay loaded across turns
   * without re-searching. Only meaningful for role === "assistant".
   */
  readonly serverToolCalls?: readonly ProviderServerToolCall[];
}

/** See ChatMessageInput.serverToolCalls. */
export interface ProviderServerToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  /** Provider-computed result; absent when the stream ended before it arrived. */
  readonly result?: unknown;
}

export type ContentPart = TextPart | ImagePart;
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}
export interface ImagePart {
  readonly type: "image";
  readonly base64: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface ProviderThinkingBlock {
  readonly thinking: string;
  readonly signature: string;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * One chunk of the system prompt with explicit cache eligibility.
 * Anthropic adapters set `cache_control: ephemeral` on chunks marked
 * `cacheable: true` and ship the volatile chunks (chips) without it,
 * so prompt-cache stays warm across turns even as chips change.
 * Providers without prompt-cache concatenate chunks and ignore the flag.
 */
export interface SystemPromptChunk {
  readonly body: string;
  readonly cacheable: boolean;
  /** Stable label for telemetry / debugging — not sent to the model. */
  readonly label: string;
}

export interface GenerateInput {
  /**
   * Either a flat string (legacy) or an ordered list of chunks. Adapters
   * that support prompt-cache treat the chunked form as cache breakpoints.
   */
  readonly systemPrompt: string | readonly SystemPromptChunk[];
  readonly messages: readonly ChatMessageInput[];
  readonly tools: readonly ToolDefinition[];
  /** Anthropic-style cache breakpoints; ignored by providers that don't
   * support it. */
  readonly cacheBreakpoints?: readonly ("system" | "tools")[];
  /** Optional per-call overrides. */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** When the host request aborts, providers should stop emitting events. */
  readonly abortSignal?: AbortSignal;
  /**
   * v0.2.54 — when set, providers that support extended thinking
   * (Anthropic claude-3.7+, claude-4.x) enable it for this call with
   * the given budget. Anthropic constraint: budget_tokens must be
   * ≥ 1024 and < maxTokens. Providers without thinking ignore this.
   */
  readonly thinking?: { readonly budgetTokens: number };
  /**
   * Force the model's tool use for a structured-output call. `{type:"tool",
   * toolName}` pins it to one tool (the `moduleize` submit_module pattern);
   * "required" forces some tool; "auto"/"none" are the SDK defaults/off.
   * Providers that don't support forcing ignore it. Without it, a single-tool
   * prompt is NOT reliably obeyed — the model may reply with prose instead.
   */
  readonly toolChoice?:
    | { readonly type: "tool"; readonly toolName: string }
    | "auto"
    | "required"
    | "none";
}

export type ProviderEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; id: string; name: string; arguments: unknown }
  /**
   * Provider-executed (server) tool call — e.g. Anthropic Tool Search.
   * The API already ran it inside the request; consumers must NOT
   * dispatch it, only record it so the call/result blocks can be
   * replayed unchanged on subsequent requests (tool-search docs:
   * dropping them makes the model re-search every turn).
   */
  | { kind: "server-tool-call"; id: string; name: string; arguments: unknown }
  | { kind: "server-tool-result"; id: string; name: string; result: unknown }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
    }
  | {
      kind: "done";
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
      /**
       * v0.10.17 — diagnostic payload for the empty-response root-cause
       * hunt. Optional; only Vercel-SDK-backed adapters populate it.
       * `rawFinishReason` is the SDK's pre-mapping reason ("stop",
       * "tool-calls", "length", "content-filter", "other", "unknown",
       * "error"). `providerMetadata` carries provider-specific stop
       * info — for Anthropic, that's the raw `stop_reason`
       * ("end_turn" | "tool_use" | "stop_sequence" | "max_tokens" |
       * "refusal" | "pause_turn"). Chat-runner logs all of this when
       * it sees the empty-response shape.
       */
      stoppingDiagnostics?: {
        rawFinishReason: string | null;
        warnings: unknown;
        providerMetadata: unknown;
        responseMessageId: string | null;
        responseModelId: string | null;
      };
    }
  | { kind: "error"; message: string }
  /**
   * v0.2.54 — extended-thinking text increment. Streamed character-by-
   * character like text-delta but routed to the thinking surface in
   * the UI (collapsed details block above the assistant message).
   */
  | { kind: "thinking-delta"; text: string }
  /**
   * v0.2.54 — emitted at the END of one thinking content_block, with
   * the full block text + its cryptographic signature. Chat-runner
   * accumulates these and persists alongside the assistant message
   * for round-tripping in subsequent tool_use turns.
   */
  | { kind: "thinking-stop"; thinking: string; signature: string };

export interface AIProvider {
  readonly name: ProviderName;
  readonly model: string;
  generate(input: GenerateInput): AsyncIterable<ProviderEvent>;
}
