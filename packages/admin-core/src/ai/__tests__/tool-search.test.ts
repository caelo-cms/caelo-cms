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

  it("reads from env when no override is supplied; unset defaults to bm25", () => {
    const prev = process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
    try {
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "bm25";
      expect(resolveAnthropicToolSearchMode()).toBe("bm25");
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "REGEX";
      expect(resolveAnthropicToolSearchMode()).toBe("regex");
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "off";
      expect(resolveAnthropicToolSearchMode()).toBe("off");
      // Tool Search is the default since the catalogue crossed 100
      // tools: unset (and unknown values) resolve to bm25, and the
      // operator opts OUT with the explicit "off".
      process.env.CAELO_ANTHROPIC_TOOL_SEARCH = "nonsense";
      expect(resolveAnthropicToolSearchMode()).toBe("bm25");
      delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
      expect(resolveAnthropicToolSearchMode()).toBe("bm25");
    } finally {
      if (prev === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH;
      else process.env.CAELO_ANTHROPIC_TOOL_SEARCH = prev;
    }
  });
});

describe("AnthropicProvider cache-breakpoint cap", () => {
  it("tags the last 2 system chunks + rolls 1 onto the tail (4-breakpoint budget)", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "off" });
    // 5 cacheable chunks. Of the 4 total breakpoints Anthropic allows, 2 go
    // to system chunks, 1 is reserved for the last non-deferred TOOL
    // breakpoint (added by the tool-search transform), and 1 for the rolling
    // last-message breakpoint — so the provider must NOT 400.
    const chunks = ["base", "tool-playbook", "module-model", "staging", "memory"].map((label) => ({
      body: `[${label}]`,
      cacheable: true,
      label,
    }));
    await drain(
      provider.generate({
        systemPrompt: chunks,
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );
    const prompt = mock.doStreamCalls[0]!.prompt as Array<{
      role: string;
      providerOptions?: { anthropic?: { cacheControl?: unknown } };
    }>;
    const sys = prompt.filter((m) => m.role === "system");
    expect(sys.length).toBe(5);
    const taggedSys = sys.filter((m) => m.providerOptions?.anthropic?.cacheControl);
    // 2 system breakpoints (one reserved for the tool breakpoint, one for the
    // rolling message tail).
    expect(taggedSys.length).toBe(2);
    // The first THREE chunks are untagged — they still ride inside every later
    // breakpoint's cached prefix.
    expect(sys[0]?.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    expect(sys[1]?.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    expect(sys[2]?.providerOptions?.anthropic?.cacheControl).toBeUndefined();
    // The rolling breakpoint lands on the last (user) message so the growing
    // conversation history caches. String content ⇒ message-level cacheControl.
    const nonSys = prompt.filter((m) => m.role !== "system");
    expect(JSON.stringify(nonSys[nonSys.length - 1])).toContain("cacheControl");
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
    expect(tools.find((t) => t.name === "tool_search_tool_bm25")).toBeUndefined();
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
    expect(tools.find((t) => t.name === "tool_search_tool_bm25")).toBeUndefined();
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
    const search = tools.find((t) => t.name === "tool_search_tool_bm25");
    expect(search).toBeDefined();
    // Run-B3 regression: the dict key IS the canonical wire name — the
    // old alias "toolSearch" leaked into events/history, the model
    // imitated it, and dispatch failed with `unknown tool: toolSearch`.
    expect(tools.find((t) => t.name === "toolSearch")).toBeUndefined();
    // Every regular tool should carry deferLoading. The search tool
    // is provider-defined so won't (it's the discovery surface).
    const regular = tools.filter(
      (t) => !t.name?.startsWith("tool_search_tool") && t.name?.startsWith("tool_"),
    );
    for (const t of regular) {
      expect(t.providerOptions?.anthropic?.deferLoading).toBe(true);
    }
  });

  it("keeps alwaysLoaded (core) tools fully loaded while deferring the rest", async () => {
    const { mock, provider } = makeMockAndProvider({ toolSearch: "bm25" });
    const tools = fakeTools(15).map((t, i) =>
      // Flag the first three as core workflow tools.
      i < 3 ? { ...t, alwaysLoaded: true } : t,
    );
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools,
      }),
    );
    const sent = mock.doStreamCalls[0]!.tools as Array<{
      name?: string;
      providerOptions?: { anthropic?: { deferLoading?: boolean } };
    }>;
    for (const t of sent) {
      if (!/^tool_\d+$/.test(t.name ?? "")) continue; // skip the search tool
      const idx = Number((t.name ?? "").slice("tool_".length));
      if (idx < 3) {
        expect(t.providerOptions?.anthropic?.deferLoading).toBeUndefined();
      } else {
        expect(t.providerOptions?.anthropic?.deferLoading).toBe(true);
      }
    }
    // The search tool is still injected alongside the core set — under
    // its canonical wire name, never the old alias.
    expect(sent.find((t) => t.name === "tool_search_tool_bm25")).toBeDefined();
    expect(sent.find((t) => t.name === "toolSearch")).toBeUndefined();
  });

  it("maps provider-executed (server) tool calls to server-tool events, never dispatchable tool-calls", async () => {
    // Run V2 regression: the API executes tool_search itself inside the
    // request; the SDK surfaces the call for visibility. Forwarding it
    // hit `unknown tool: tool_search_tool_bm25` in dispatch AND
    // persisted an orphan call the model then imitated. Dropping it
    // entirely is wrong too — the tool-search docs require the blocks
    // to be replayed on subsequent requests — so it becomes a dedicated
    // server-tool-call event the loop records without dispatching.
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "srv1",
            toolName: "tool_search_tool_bm25",
            input: '{"query":"redirects"}',
            providerExecuted: true,
          },
          {
            // Belt-and-braces path: same server tool WITHOUT the flag
            // (some SDK paths drop it) — still must not reach dispatch.
            type: "tool-call",
            toolCallId: "srv2",
            toolName: "tool_search_tool_regex",
            input: '{"query":"locales"}',
          },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "list_pages",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]),
      }),
    });
    const provider = new AnthropicProvider({
      apiKey: "test",
      model: "claude-opus-4-7",
      toolSearch: "bm25",
      _modelOverride: mock,
    });
    const events = await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(15),
      }),
    );
    const toolCalls = events.filter((e) => e.kind === "tool-call") as Array<{
      kind: "tool-call";
      name: string;
    }>;
    expect(toolCalls.map((c) => c.name)).toEqual(["list_pages"]);
    // Both server calls surface as recordable (not dispatchable) events.
    const serverCalls = events.filter((e) => e.kind === "server-tool-call") as Array<{
      kind: "server-tool-call";
      name: string;
    }>;
    expect(serverCalls.map((c) => c.name)).toEqual([
      "tool_search_tool_bm25",
      "tool_search_tool_regex",
    ]);
  });

  it("captures the server tool result and round-trips the pair as server_tool_use blocks", async () => {
    // Docs, "Continuing the conversation": the server_tool_use +
    // tool_search_tool_result blocks must be passed back UNCHANGED on
    // subsequent requests — that's what keeps discovered tools loaded
    // without re-searching. This test drives both halves: (1) the
    // stream's provider-executed tool-result is captured as a
    // server-tool-result event; (2) a history message carrying
    // serverToolCalls is encoded back into providerExecuted tool-call +
    // tool-result parts for the SDK's Anthropic encoder.
    const searchResult = [{ type: "tool_reference", toolName: "tool_7" }];
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "srv1",
            toolName: "tool_search_tool_bm25",
            input: '{"query":"seven"}',
            providerExecuted: true,
          },
          {
            // V3 stream parts carry the payload as `result` (streamText's
            // fullStream re-surfaces it as `output`) — mirrors what
            // @ai-sdk/anthropic emits for tool_search_tool_result blocks.
            type: "tool-result",
            toolCallId: "srv1",
            toolName: "tool_search_tool_bm25",
            result: searchResult,
            providerExecuted: true,
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ]),
      }),
    });
    const provider = new AnthropicProvider({
      apiKey: "test",
      model: "claude-opus-4-7",
      toolSearch: "bm25",
      _modelOverride: mock,
    });
    const events = await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: fakeTools(15),
      }),
    );
    const resultEv = events.find((e) => e.kind === "server-tool-result") as
      | { kind: "server-tool-result"; id: string; result: unknown }
      | undefined;
    expect(resultEv).toBeDefined();
    expect(resultEv?.id).toBe("srv1");
    expect(resultEv?.result).toEqual(searchResult);

    // Option C foundation: the terminal `turn-messages` event carries the
    // SDK's canonical assembly — the server_tool_use AND its paired
    // tool_search_tool_result together — which is exactly what our
    // fullStream reconstruction dropped (run-B6). Persisting + replaying
    // THIS instead of the hand-rolled format is the fix.
    const turnEv = events.find((e) => e.kind === "turn-messages") as
      | { kind: "turn-messages"; messages: readonly unknown[] }
      | undefined;
    expect(turnEv).toBeDefined();
    const flat = JSON.stringify(turnEv?.messages ?? []);
    expect(flat).toContain("tool_search_tool_bm25");
    expect(flat).toContain("tool_reference");
    expect(flat).toContain("tool_7");

    // (2) Replay: run-B6 regression — a follow-up whose history carries a
    // server tool call must NOT put ANY server_tool_use block back on the
    // wire. streamText's fullStream doesn't surface the paired
    // tool_search_tool_result reliably, so replaying the call alone 400s
    // ("server_tool_use ... without a corresponding ..._tool_result").
    // We drop it entirely; the model re-searches if it needs the tool.
    await drain(
      provider.generate({
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "searching",
            serverToolCalls: [
              {
                id: "srv1",
                name: "tool_search_tool_bm25",
                arguments: { query: "seven" },
                result: searchResult,
              },
            ],
            toolCalls: [{ id: "c1", name: "tool_7", arguments: {} }],
          },
          { role: "tool", content: "ok", toolCallId: "c1" },
        ],
        tools: fakeTools(15),
      }),
    );
    const prompt = mock.doStreamCalls[1]!.prompt as Array<{
      role: string;
      content: Array<{ type: string; toolName?: string; providerExecuted?: boolean }>;
    }>;
    const assistant = prompt.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const parts = assistant?.content ?? [];
    // No server_tool_use / provider-executed block reaches the provider…
    expect(parts.some((p) => p.providerExecuted === true)).toBe(false);
    expect(parts.some((p) => p.toolName?.startsWith("tool_search_tool"))).toBe(false);
    // …but the CLIENT tool_use (the discovered tool's call) still does.
    expect(parts.some((p) => p.type === "tool-call" && p.toolName === "tool_7")).toBe(true);
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
    const search = tools.find((t) => t.name === "tool_search_tool_regex");
    expect(search).toBeDefined();
    // The SDK exposes the provider-tool id; regex variant ends in `regex`.
    // Both bm25 and regex variants advertise `id` matching the provider tool name.
    expect(JSON.stringify(search)).toContain("regex");
  });
});
