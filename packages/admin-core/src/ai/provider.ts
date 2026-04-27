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
  readonly content: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  /** Set when role === "tool" — references the assistant's tool_use id. */
  readonly toolCallId?: string;
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
  | { kind: "error"; message: string };

export interface AIProvider {
  readonly name: ProviderName;
  readonly model: string;
  generate(input: GenerateInput): AsyncIterable<ProviderEvent>;
}
