// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W2 — Anthropic Tool Search transform.
 *
 * We can't easily test against the real Anthropic API in CI, so these
 * tests verify the wiring: when `toolSearch` is enabled and the
 * catalogue is above the threshold, every regular tool gets tagged
 * with `providerOptions.anthropic.deferLoading: true` and a
 * `toolSearch` tool is injected into the dictionary that goes to
 * streamText. When disabled (or catalogue too small), the tools dict
 * is unchanged.
 *
 * Approach: drive AnthropicProvider with a MockLanguageModelV3 that
 * records the prompt + tools passed to doStream. Inspect the call
 * record to confirm the transform fired (or didn't).
 */

import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";

import type { GenerateInput, ProviderEvent } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { resolveAnthropicToolSearchMode } from "../providers/index.js";

function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeTools(count: number): GenerateInput["tools"] {
  return Array.from({ length: count }, (_v, i) => ({
    name: `tool_${i}`,
    description: `Fake tool ${i}`,
    inputSchema: { type: "object" },
  }));
}

function makeMockAndProvider(opts: { toolSearch?: "off" | "bm25" | "regex" }): {
  mock: MockLanguageModelV3;
  provider: AnthropicProvider;
} {
  const mock = new MockLanguageModelV3({
    doStream: async () => ({
      stream: streamOf([
        { type: "stream-start", warnings: [] },
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
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-opus-4-7",
    toolSearch: opts.toolSearch ?? "off",
    _modelOverride: mock,
  });
  return { mock, provider };
}

async function drain(p: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of p) out.push(e);
  return out;
}

describe("resolveAnthropicToolSearchMode", () => {
  it("returns the explicit override unchanged", () => {
    expect(resolveAnthropicToolSearchMode("bm25")).toBe("bm25");
    expect(resolveAnthropicToolSearchMode("regex")).toBe("regex");
    expect(resolveAnthropicToolSearchMode("off")).toBe("off");
  });

  it("reads from env when no override is supplied", () => {
    const prev = process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
    try {
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "bm25";
      expect(resolveAnthropicToolSearchMode()).toBe("bm25");
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "REGEX";
      expect(resolveAnthropicToolSearchMode()).toBe("regex");
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "nonsense";
      expect(resolveAnthropicToolSearchMode()).toBe("off");
      delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
      expect(resolveAnthropicToolSearchMode()).toBe("off");
    } finally {
      if (prev === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
      else process.env.CAELO_ANTHROPIC_TOOL_SEARCH = prev;
    }
  });
});

describe("AnthropicProvider tool-search transform (W2)", () => {
  it("does NOT mutate tools when toolSearch=off (default)", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "off" });
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(20),
      }),
    );
    expect(mock.doStreamCalls.length).toBe(1);
    const call = mock.doStreamCalls[0]!;
    expect(call.tools).toBeDefined();
    // Tool count equals caelo's catalogue — no search tool injected.
    const tools = call.tools as Array<{ name?: string; providerOptions?: unknown }>;
    expect(tools.length).toBe(20);
    expect(tools.find((t) => t.name === "toolSearch")).toBeUndefined();
    // None should carry deferLoading.
    for (const t of tools) {
      const po = (t as { providerOptions?: { anthropic?: { deferLoading?: boolean } } })
        .providerOptions;
      expect(po?.anthropic?.deferLoading).toBeUndefined();
    }
  });

  it("does NOT enable search when catalogue is below the threshold even with toolSearch=bm25", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "bm25" });
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(5),
      }),
    );
    const tools = mock.doStreamCalls[0]!.tools as Array<{ name?: string }>;
    expect(tools.length).toBe(5);
    expect(tools.find((t) => t.name === "toolSearch")).toBeUndefined();
  });

  it("tags every tool with deferLoading + injects a search tool when toolSearch=bm25 + catalogue ≥ threshold", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "bm25" });
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(15),
      }),
    );
    const tools = mock.doStreamCalls[0]!.tools as Array<{
      name?: string;
      type?: string;
      providerOptions?: { anthropic?: { deferLoading?: boolean } };
    }>;
    // 15 regular tools + 1 search tool — but the SDK may shape the
    // search tool into the same array OR as a special provider entry.
    // Test the invariants directly.
    expect(tools.length).toBeGreaterThanOrEqual(15);
    const search = tools.find((t) => t.name === "toolSearch");
    expect(search).toBeDefined();
    // Every regular tool should carry deferLoading. The search tool
    // is provider-defined so won't (it's the discovery surface).
    const regular = tools.filter((t) => t.name !== "toolSearch" && t.name?.startsWith("tool_"));
    for (const t of regular) {
      expect(t.providerOptions?.anthropic?.deferLoading).toBe(true);
    }
  });

  it("uses the regex variant when toolSearch=regex", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "regex" });
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(15),
      }),
    );
    const tools = mock.doStreamCalls[0]!.tools as Array<{ name?: string; id?: string }>;
    const search = tools.find((t) => t.name === "toolSearch");
    expect(search).toBeDefined();
    // The SDK exposes the provider-tool id; regex variant ends in `regex`.
    // Both bm25 and regex variants advertise `id` matching the provider tool name.
    expect(JSON.stringify(search)).toContain("regex");
  });
});
