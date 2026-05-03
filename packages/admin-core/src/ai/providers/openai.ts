// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — OpenAI text adapter (chat.completions, streaming, tool-use).
 *
 * Uses raw fetch — no `openai` SDK dep — for the same reason the
 * Anthropic adapter does: keeps the dep tree small + works against
 * any runtime (Node/Bun/L@E/Cloudflare workers without polyfills).
 *
 * Streaming protocol: OpenAI emits `data: {json}` lines; the json is
 * a partial Chat Completions response. Tool-use comes back as
 * `delta.tool_calls[i].function.{name?, arguments}` — arguments arrive
 * incrementally as concatenated JSON strings, so the adapter
 * accumulates per-tool-call-id and parses once on stop. Usage comes
 * with the FINAL chunk only when `stream_options: {include_usage: true}`
 * is sent.
 *
 * The OpenAI-compatible adapter (Ollama / LM Studio / vLLM / LocalAI)
 * extends this by passing a different baseUrl + skipping usage when
 * the local server doesn't report it.
 */

import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ProviderName,
  SystemPromptChunk,
} from "../provider.js";

interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Some providers (vLLM with auth disabled) return 200 even on key
   * errors; this controls whether we trust the auth-OK signal. Default true. */
  readonly trustAuth?: boolean;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAiProvider implements AIProvider {
  readonly name: ProviderName = "openai";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    const messages = toOpenAiMessages(input.systemPrompt, input.messages);
    const tools = input.tools.length > 0 ? toOpenAiTools(input.tools) : undefined;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) body.tools = tools;
    if (typeof input.maxTokens === "number") body.max_tokens = input.maxTokens;
    if (typeof input.temperature === "number") body.temperature = input.temperature;

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.abortSignal,
      });
    } catch (e) {
      yield { kind: "error", message: `openai fetch failed: ${(e as Error).message}` };
      yield { kind: "done", stopReason: "error" };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      yield { kind: "error", message: `openai ${res.status}: ${detail.slice(0, 500)}` };
      yield { kind: "done", stopReason: "error" };
      return;
    }

    // Accumulator for delta tool-call args (OpenAI streams them as
    // string fragments per tool_call_id). Keyed by tool_call.index.
    const toolCallAccum = new Map<number, { id: string; name: string; argsJson: string }>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let stopReason: ProviderEvent extends infer E
      ? E extends { kind: "done"; stopReason: infer S }
        ? S
        : never
      : never = "end_turn";
    let usage: { input: number; output: number; cached: number } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (choice?.delta?.content) {
          yield { kind: "text-delta", text: choice.delta.content as string };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls as Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>) {
            const slot = toolCallAccum.get(tc.index) ?? { id: "", name: "", argsJson: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
            toolCallAccum.set(tc.index, slot);
          }
        }
        if (choice?.finish_reason === "tool_calls") stopReason = "tool_use";
        if (choice?.finish_reason === "length") stopReason = "max_tokens";
        if (choice?.finish_reason === "stop") stopReason = "end_turn";
        if (parsed.usage) {
          usage = {
            input: parsed.usage.prompt_tokens ?? 0,
            output: parsed.usage.completion_tokens ?? 0,
            cached: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    }

    // Emit accumulated tool calls (one event per slot).
    for (const slot of [...toolCallAccum.values()]) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(slot.argsJson || "{}");
      } catch {
        // Malformed args — surface as empty object; chat-runner's tool
        // dispatcher Zod-validates + rejects with a structured error.
      }
      yield { kind: "tool-call", id: slot.id, name: slot.name, arguments: parsedArgs };
    }
    if (usage) {
      yield {
        kind: "usage",
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
      };
    }
    yield { kind: "done", stopReason };
  }
}

function toOpenAiMessages(
  systemPrompt: GenerateInput["systemPrompt"],
  messages: readonly ChatMessageInput[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  // System prompt first. Multi-chunk = concatenate (no per-chunk
  // cache support in OpenAI).
  const sys =
    typeof systemPrompt === "string"
      ? systemPrompt
      : (systemPrompt as readonly SystemPromptChunk[]).map((c) => c.body).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toOpenAiTools(tools: GenerateInput["tools"]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
