// SPDX-License-Identifier: MPL-2.0

/**
 * Anthropic Messages API provider. Hand-written against the public SSE
 * contract instead of pulling in the SDK so the dep tree stays small
 * (CLAUDE.md §3) and the fixture-replay layer doesn't have to mock an
 * SDK surface.
 *
 * Stream shape (https://docs.anthropic.com/en/api/messages-streaming):
 *   message_start, content_block_start (text or tool_use),
 *   content_block_delta (text_delta or input_json_delta),
 *   content_block_stop, message_delta (usage), message_stop.
 *
 * All provider-brand strings are scoped to this file plus the registry
 * factory; the chat surface upstream sees only the abstract ProviderEvent
 * union, satisfying the "provider brand never surfaces in editor chat
 * UI" invariant from §4.
 */

import type { AIProvider, GenerateInput, ProviderEvent, ProviderName } from "../provider.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Optional fetch override — used by the fixture-replay test. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Builds the Anthropic /v1/messages request body from our generic
 * GenerateInput. Tool_use / tool_result messages flatten into Anthropic's
 * content-block array shape.
 */
function buildRequestBody(input: GenerateInput, model: string): Record<string, unknown> {
  const tools = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const messages = input.messages.map((m) => {
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      // v0.2.54 — thinking blocks (when present) MUST appear FIRST in
      // the assistant content, before text + tool_use, with their
      // cryptographic signatures intact. Anthropic verifies the
      // signatures across tool-use turn boundaries to ensure the
      // reasoning carried over from the prior turn was the model's
      // own; stripping or reordering returns HTTP 400 on the next
      // generate call.
      for (const tb of m.thinkingBlocks ?? []) {
        blocks.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature });
      }
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: "assistant", content: blocks };
    }
    // role === "tool"
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        },
      ],
    };
  });

  // System prompt structure (P5.2 #4):
  //   - chunked form: each {body, cacheable, label} chunk becomes a text
  //     block; cacheable chunks carry `cache_control: ephemeral` so the
  //     prompt-cache prefix stays warm across turns even when volatile
  //     chunks (chips) change.
  //   - flat string with cacheBreakpoints.system: legacy single-block cache.
  //   - flat string without breakpoint: plain string body.
  let systemBlock: unknown;
  if (typeof input.systemPrompt !== "string") {
    systemBlock = input.systemPrompt.map((c) =>
      c.cacheable
        ? { type: "text", text: c.body, cache_control: { type: "ephemeral" } }
        : { type: "text", text: c.body },
    );
  } else if (input.cacheBreakpoints?.includes("system")) {
    systemBlock = [
      { type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } },
    ];
  } else {
    systemBlock = input.systemPrompt;
  }

  // v0.2.54 — default lifted to 32768. v0.2.53 set 16k as a step up
  // from the legacy 4k Sonnet-3-era default, but compose-page sessions
  // with extended thinking enabled (thinking budget 10k + post-thinking
  // text + multi-tool batch) routinely cleared 16k. 32k matches Opus
  // 4.7's standard ceiling and leaves room for the thinking body. Tool-
  // use blocks count toward this. Tune via /security/ai → Max output
  // tokens (1024-200000) when the model supports more.
  const body: Record<string, unknown> = {
    model,
    max_tokens: input.maxTokens ?? 32768,
    system: systemBlock,
    messages,
    stream: true,
  };
  if (tools.length > 0) body.tools = tools;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  // v0.2.54 — extended thinking. Anthropic constraint: budget_tokens
  // must be ≥ 1024 AND strictly less than max_tokens (the model needs
  // room for the response after thinking). When temperature is set
  // alongside thinking, Anthropic also requires temperature=1; the
  // chat-runner doesn't set temperature, so we inherit Anthropic's
  // own default of 1, which is compatible.
  if (input.thinking) {
    const max = (body.max_tokens as number) ?? 32768;
    const budget = Math.max(1024, Math.min(input.thinking.budgetTokens, max - 1024));
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  return body;
}

/**
 * Iterates lines from a Response body's reader, yielding parsed `data: …`
 * SSE payloads. Discards `event: …` / blank lines.
 */
async function* readSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line.startsWith("data: ")) {
        const payload = line.slice("data: ".length);
        if (payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Malformed line; skip — Anthropic occasionally splits across reads.
        }
      }
    }
  }
}

/**
 * Translates Anthropic's content-block stream events into our generic
 * ProviderEvent union. Tool-call argument JSON arrives as a stream of
 * `input_json_delta` strings and we accumulate them per content-block
 * index before emitting one `tool-call` event per call.
 */
async function* translate(events: AsyncIterable<unknown>): AsyncIterable<ProviderEvent> {
  const toolCallBuf: Map<number, { id: string; name: string; argText: string }> = new Map();
  // v0.2.54 — accumulate thinking text + signature per content_block
  // index. Both arrive as deltas (thinking_delta = body, signature_delta
  // = trailing signature appended once at the end), and content_block_stop
  // is when we yield the assembled thinking-stop event for the runner
  // to persist. Mid-stream we yield thinking-delta events for the UI.
  const thinkingBuf: Map<number, { text: string; signature: string }> = new Map();
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  for await (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    const type = e.type;

    if (type === "message_start") {
      const usageRaw = (e.message as { usage?: Record<string, number> } | undefined)?.usage;
      if (usageRaw) {
        usage = {
          inputTokens: usageRaw.input_tokens ?? 0,
          outputTokens: usageRaw.output_tokens ?? 0,
          cachedTokens: usageRaw.cache_read_input_tokens ?? 0,
        };
      }
    } else if (type === "content_block_start") {
      const idx = e.index as number;
      const block = e.content_block as { type?: string; id?: string; name?: string };
      if (block?.type === "tool_use") {
        toolCallBuf.set(idx, { id: block.id ?? "", name: block.name ?? "", argText: "" });
      } else if (block?.type === "thinking") {
        thinkingBuf.set(idx, { text: "", signature: "" });
      }
    } else if (type === "content_block_delta") {
      const idx = e.index as number;
      const delta = e.delta as {
        type?: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
      };
      if (delta?.type === "text_delta") {
        if (typeof delta.text === "string") yield { kind: "text-delta", text: delta.text };
      } else if (delta?.type === "input_json_delta") {
        const buf = toolCallBuf.get(idx);
        if (buf && typeof delta.partial_json === "string") buf.argText += delta.partial_json;
      } else if (delta?.type === "thinking_delta") {
        const tb = thinkingBuf.get(idx);
        if (tb && typeof delta.thinking === "string") {
          tb.text += delta.thinking;
          yield { kind: "thinking-delta", text: delta.thinking };
        }
      } else if (delta?.type === "signature_delta") {
        const tb = thinkingBuf.get(idx);
        if (tb && typeof delta.signature === "string") {
          tb.signature += delta.signature;
        }
      }
    } else if (type === "content_block_stop") {
      const idx = e.index as number;
      const buf = toolCallBuf.get(idx);
      if (buf) {
        let parsed: unknown = {};
        try {
          parsed = buf.argText.length > 0 ? JSON.parse(buf.argText) : {};
        } catch {
          parsed = { __parse_error: buf.argText };
        }
        yield { kind: "tool-call", id: buf.id, name: buf.name, arguments: parsed };
        toolCallBuf.delete(idx);
      }
      // v0.2.54 — close-out for thinking blocks. Emit one thinking-stop
      // event with the assembled text + signature so the runner can
      // persist + round-trip on the next loop iteration.
      const tb = thinkingBuf.get(idx);
      if (tb) {
        yield { kind: "thinking-stop", thinking: tb.text, signature: tb.signature };
        thinkingBuf.delete(idx);
      }
    } else if (type === "message_delta") {
      const usageRaw = e.usage as Record<string, number> | undefined;
      if (usageRaw) {
        usage = {
          inputTokens: usage.inputTokens || (usageRaw.input_tokens ?? 0),
          outputTokens: usageRaw.output_tokens ?? usage.outputTokens,
          cachedTokens: usage.cachedTokens || (usageRaw.cache_read_input_tokens ?? 0),
        };
      }
      const stopReason = (e.delta as { stop_reason?: string } | undefined)?.stop_reason;
      yield { kind: "usage", ...usage };
      if (stopReason) {
        yield {
          kind: "done",
          stopReason:
            stopReason === "end_turn"
              ? "end_turn"
              : stopReason === "tool_use"
                ? "tool_use"
                : stopReason === "max_tokens"
                  ? "max_tokens"
                  : "error",
        };
      }
    } else if (type === "error") {
      const msg = (e.error as { message?: string } | undefined)?.message ?? "provider error";
      yield { kind: "error", message: msg };
      yield { kind: "done", stopReason: "error" };
    }
  }
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    const body = buildRequestBody(input, this.model);
    const res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: input.abortSignal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield { kind: "error", message: `provider HTTP ${res.status}: ${text.slice(0, 500)}` };
      yield { kind: "done", stopReason: "error" };
      return;
    }
    const reader = res.body.getReader();
    try {
      for await (const ev of translate(readSse(reader))) {
        if (input.abortSignal?.aborted) return;
        yield ev;
      }
    } finally {
      reader.releaseLock();
    }
  }
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
