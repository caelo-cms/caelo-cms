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
}

export type ProviderEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; id: string; name: string; arguments: unknown }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
    }
  | { kind: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" }
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
