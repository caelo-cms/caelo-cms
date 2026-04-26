// SPDX-License-Identifier: MPL-2.0

/**
 * Replays a recorded SSE stream through AnthropicProvider's translator
 * and asserts the ProviderEvent sequence matches expectations. Uses a
 * mock `fetch` that returns a ReadableStream of canned SSE bytes — no
 * network, no SDK, no live key.
 */

import { describe, expect, it } from "bun:test";
import type { ProviderEvent } from "../provider.js";
import { AnthropicProvider, FixtureProvider } from "../providers/anthropic.js";

function makeMockFetch(sseLines: string[]): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("AnthropicProvider SSE translator", () => {
  it("emits text-delta events for streamed text", async () => {
    const lines = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ];
    const provider = new AnthropicProvider({
      apiKey: "test",
      model: "claude-opus-4-7",
      fetchImpl: makeMockFetch(lines),
    });
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({ systemPrompt: "x", messages: [], tools: [] })) {
      events.push(e);
    }
    expect(events).toEqual([
      { kind: "text-delta", text: "Hello" },
      { kind: "text-delta", text: " world" },
      { kind: "usage", inputTokens: 50, outputTokens: 12, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("aggregates input_json_delta into one tool-call event", async () => {
    const lines = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })}`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "edit_module" },
      })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"moduleId":"abc' } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '","html":"<p>x</p>"}' } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } })}`,
    ];
    const provider = new AnthropicProvider({
      apiKey: "test",
      model: "claude-opus-4-7",
      fetchImpl: makeMockFetch(lines),
    });
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({ systemPrompt: "x", messages: [], tools: [] })) {
      events.push(e);
    }
    const toolCall = events.find((e) => e.kind === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall && toolCall.kind === "tool-call") {
      expect(toolCall.name).toBe("edit_module");
      expect(toolCall.arguments).toEqual({ moduleId: "abc", html: "<p>x</p>" });
    }
    expect(events.find((e) => e.kind === "done")?.kind).toBe("done");
  });

  it("yields error event on non-2xx HTTP", async () => {
    const fetchImpl = (async () =>
      new Response("upstream nope", { status: 500 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({
      apiKey: "test",
      model: "claude-opus-4-7",
      fetchImpl,
    });
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({ systemPrompt: "", messages: [], tools: [] })) {
      events.push(e);
    }
    expect(events[0]?.kind).toBe("error");
    expect(events[1]?.kind).toBe("done");
  });
});

describe("FixtureProvider", () => {
  it("yields the canned event list", async () => {
    const canned: ProviderEvent[] = [
      { kind: "text-delta", text: "ok" },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
    const provider = new FixtureProvider(canned);
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({ systemPrompt: "", messages: [], tools: [] })) {
      events.push(e);
    }
    expect(events).toEqual(canned);
  });
});
