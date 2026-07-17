// SPDX-License-Identifier: MPL-2.0

/**
 * Provider-translator coverage. The hand-rolled SSE parser was replaced
 * in v0.3.0 by `@ai-sdk/anthropic` + `streamText`; SSE-byte parsing is
 * now the SDK's responsibility (and tested in its own suite). What we
 * still own is the translation layer that maps the SDK's
 * LanguageModelV2 stream parts → Caelo's `ProviderEvent` union — these
 * tests exercise that layer end-to-end through `AnthropicProvider`,
 * using `MockLanguageModelV3` so no API key + no network are needed.
 *
 * Plus the existing FixtureProvider sanity test (used elsewhere by
 * chat-runner regression tests).
 */

import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { ProviderEvent } from "../provider.js";
import { AnthropicProvider, FixtureProvider } from "../providers/anthropic.js";

function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * Construct an AnthropicProvider with `_modelOverride` pointing at a
 * MockLanguageModelV3. This bypasses the SDK's createAnthropic()
 * factory + API-key check so the SDK runs against the mock's stream
 * directly — same code path streamText uses for any LanguageModelV2.
 */
function providerWithMock(mock: MockLanguageModelV3): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "test",
    model: "claude-opus-4-7",
    _modelOverride: mock,
  });
}

describe("AnthropicProvider — SDK-event translation", () => {
  it("emits text-delta events for streamed text + usage + done", async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello" },
          { type: "text-delta", id: "t1", delta: " world" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 50 }, outputTokens: { total: 12 } },
          },
        ]),
      }),
    });
    const provider = providerWithMock(mock);
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(e);
    }
    expect(events).toEqual([
      { kind: "text-delta", text: "Hello" },
      { kind: "text-delta", text: " world" },
      { kind: "usage", inputTokens: 50, outputTokens: 12, cachedTokens: 0 },
      // v0.10.17 — `done` now carries optional `stoppingDiagnostics`
      // (provider stop_reason + SDK warnings) for the empty-response
      // root-cause hunt. Existence is asserted separately below; the
      // shape varies with the underlying SDK version so we don't
      // pin it here.
      expect.objectContaining({ kind: "done", stopReason: "end_turn" }),
      // Option C (2026-07) — after `done`, the provider emits the SDK's
      // canonical assistant messages for the turn (persisted + replayed
      // as history). The chat-runner drains past `done` to the stream
      // end, so a trailing event is captured, not missed.
      expect.objectContaining({ kind: "turn-messages" }),
    ]);
    const done = events.find((e) => e.kind === "done");
    if (done && done.kind === "done") {
      expect(done.stoppingDiagnostics).toBeDefined();
    }
  });

  it("emits one tool-call event with parsed args + done(tool_use)", async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "tu_1", toolName: "edit_module" },
          { type: "tool-input-delta", id: "tu_1", delta: '{"moduleId":"abc"' },
          { type: "tool-input-delta", id: "tu_1", delta: ',"html":"<p>x</p>"}' },
          { type: "tool-input-end", id: "tu_1" },
          {
            type: "tool-call",
            toolCallId: "tu_1",
            toolName: "edit_module",
            input: '{"moduleId":"abc","html":"<p>x</p>"}',
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: { total: 10 }, outputTokens: { total: 30 } },
          },
        ]),
      }),
    });
    const provider = providerWithMock(mock);
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(e);
    }
    const toolCall = events.find((e) => e.kind === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall && toolCall.kind === "tool-call") {
      expect(toolCall.name).toBe("edit_module");
      expect(toolCall.arguments).toEqual({ moduleId: "abc", html: "<p>x</p>" });
    }
    expect(events.find((e) => e.kind === "done")?.kind).toBe("done");
    const done = events.find((e) => e.kind === "done");
    expect(done && done.kind === "done" && done.stopReason).toBe("tool_use");
  });

  it("emits thinking-delta + thinking-stop with the signature for reasoning content", async () => {
    const SIGNATURE = "sig-test-anthropic-translator";
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "reasoning-start",
            id: "r1",
            providerMetadata: { anthropic: { signature: SIGNATURE } },
          },
          { type: "reasoning-delta", id: "r1", delta: "thinking..." },
          {
            type: "reasoning-end",
            id: "r1",
            providerMetadata: { anthropic: { signature: SIGNATURE } },
          },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]),
      }),
    });
    const provider = providerWithMock(mock);
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(e);
    }
    const tDelta = events.find((e) => e.kind === "thinking-delta");
    expect(tDelta).toBeTruthy();
    if (tDelta && tDelta.kind === "thinking-delta") expect(tDelta.text).toBe("thinking...");
    const tStop = events.find((e) => e.kind === "thinking-stop");
    expect(tStop).toBeTruthy();
    if (tStop && tStop.kind === "thinking-stop") {
      expect(tStop.thinking).toBe("thinking...");
      expect(tStop.signature).toBe(SIGNATURE);
    }
  });

  it("yields error + done(error) on a stream error event", async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("upstream nope") },
        ]),
      }),
    });
    const provider = providerWithMock(mock);
    const events: ProviderEvent[] = [];
    for await (const e of provider.generate({
      systemPrompt: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
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
