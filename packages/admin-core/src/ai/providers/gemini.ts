// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — Google Gemini text adapter.
 *
 * Uses the Generative Language API (`generativelanguage.googleapis.com`)
 * directly via fetch — no `@google/generative-ai` SDK dep. Streams via
 * `?alt=sse` returning SSE-formatted JSON deltas.
 *
 * Tool-use shape: Gemini calls them `functionDeclarations` (under
 * `tools[].function_declarations`); responses come back as `parts` with
 * either `text` or `functionCall: {name, args: {...}}`. Args are
 * already parsed objects (not stringified), unlike OpenAI.
 *
 * Vertex AI's `imagen-3.0-generate-001` lives behind a different host
 * (`<region>-aiplatform.googleapis.com`); image generation is in the
 * sibling `image-provider.ts` so this file stays text-only.
 */

import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  ProviderEvent,
  ProviderName,
  SystemPromptChunk,
} from "../provider.js";

interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export class GeminiProvider implements AIProvider {
  readonly name: ProviderName = "google";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(input.messages),
      systemInstruction: { parts: [{ text: collapseSystem(input.systemPrompt) }] },
    };
    if (input.tools.length > 0) {
      body.tools = [
        {
          function_declarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }
    const generationConfig: Record<string, unknown> = {};
    if (typeof input.maxTokens === "number") generationConfig.maxOutputTokens = input.maxTokens;
    if (typeof input.temperature === "number") generationConfig.temperature = input.temperature;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    let res: Response;
    try {
      res = await this.#fetch(
        `${this.#baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.#apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: input.abortSignal,
        },
      );
    } catch (e) {
      yield { kind: "error", message: `gemini fetch failed: ${(e as Error).message}` };
      yield { kind: "done", stopReason: "error" };
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      yield { kind: "error", message: `gemini ${res.status}: ${detail.slice(0, 500)}` };
      yield { kind: "done", stopReason: "error" };
      return;
    }

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
        if (!data) continue;
        let parsed: GeminiStreamChunk;
        try {
          parsed = JSON.parse(data) as GeminiStreamChunk;
        } catch {
          continue;
        }
        const candidate = parsed.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === "string" && part.text.length > 0) {
            yield { kind: "text-delta", text: part.text };
          }
          if (part.functionCall) {
            yield {
              kind: "tool-call",
              // Gemini doesn't supply a stable id; synthesize one. The
              // chat-runner uses `id` to correlate tool_use → tool_result;
              // a per-call uuid is sufficient.
              id: crypto.randomUUID(),
              name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
            };
            stopReason = "tool_use";
          }
        }
        if (candidate?.finishReason === "STOP") stopReason = "end_turn";
        if (candidate?.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
        if (parsed.usageMetadata) {
          usage = {
            input: parsed.usageMetadata.promptTokenCount ?? 0,
            output: parsed.usageMetadata.candidatesTokenCount ?? 0,
            cached: parsed.usageMetadata.cachedContentTokenCount ?? 0,
          };
        }
      }
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

function collapseSystem(systemPrompt: GenerateInput["systemPrompt"]): string {
  if (typeof systemPrompt === "string") return systemPrompt;
  return (systemPrompt as readonly SystemPromptChunk[]).map((c) => c.body).join("\n\n");
}

function toGeminiContents(messages: readonly ChatMessageInput[]): Array<Record<string, unknown>> {
  // Gemini wants alternating user/model. Tool results are role='user'
  // with `functionResponse` parts.
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolCallId ?? "tool",
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];
    if (m.content) parts.push({ text: m.content });
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
      }
    }
    out.push({ role, parts });
  }
  return out;
}
