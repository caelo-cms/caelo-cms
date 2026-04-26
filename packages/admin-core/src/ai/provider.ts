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

export interface GenerateInput {
  /** System prompt — site_ai_memory + tool catalogue. */
  readonly systemPrompt: string;
  readonly messages: readonly ChatMessageInput[];
  readonly tools: readonly ToolDefinition[];
  /** Anthropic-style cache breakpoints; ignored by providers that don't
   * support it. */
  readonly cacheBreakpoints?: readonly ("system" | "tools")[];
  /** Optional per-call overrides. */
  readonly maxTokens?: number;
  readonly temperature?: number;
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
