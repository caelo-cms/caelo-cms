// SPDX-License-Identifier: MPL-2.0

/**
 * #991 — what load_skill's tool references look like on the Anthropic wire,
 * replayed from the stored rows (`buildProviderHistory`) as a later turn
 * sends them. The tool_result must carry ONLY `{type: "tool_reference",
 * tool_name}` blocks — the API refuses text next to them ("Tool
 * definitions/code execution functions cannot be mixed with other
 * content", e2e-livedit run 41651726318) — and the result text must follow
 * every tool_result of the step as a text block. Every referenced tool must
 * be in `tools` with `defer_loading` — a reference to a tool the request
 * lacks is a 400. The SDK request builder runs for real; the fetch is
 * stubbed, nothing leaves the process.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { buildProviderHistory } from "../chat-runner/attachments.js";
import { toolReferenceMessages } from "../chat-runner/tool-dispatch.js";
import type { ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

function recordingFetch(): { fetch: typeof fetch; body: () => Record<string, unknown> } {
  let captured = "";
  const stub = (async (_url: unknown, init?: RequestInit) => {
    captured ||= String(init?.body);
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "stub" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: stub, body: () => JSON.parse(captured) as Record<string, unknown> };
}

const tool = (name: string, alwaysLoaded: boolean): ToolDefinition => ({
  name,
  description: `fixture ${name}`,
  inputSchema: { type: "object", properties: {} },
  alwaysLoaded,
});

// Above the tool-search threshold (10): the core tools ship in full, the
// rest defer.
const tools: ToolDefinition[] = [
  tool("load_skill", true),
  tool("build_page", true),
  ...Array.from({ length: 10 }, (_, i) => tool(`long_tail_${i}`, false)),
  tool("set_theme_tokens", false),
];

function provider(fetchStub: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "test-key",
    model: "claude-opus-4-7",
    toolSearch: "bm25",
    _modelOverride: createAnthropic({ apiKey: "test-key", fetch: fetchStub })("claude-opus-4-7"),
  });
}

describe("load_skill tool references on the Anthropic wire (#991)", () => {
  test("the provider names exactly the tools it defers", () => {
    const p = provider(recordingFetch().fetch);
    expect([...p.deferredToolNames(tools)].sort()).toEqual(
      [...Array.from({ length: 10 }, (_, i) => `long_tail_${i}`), "set_theme_tokens"].sort(),
    );
    expect(p.deferredToolNames(tools.slice(0, 5)).size).toBe(0);
  });

  test("a stored referencing result replays as references-only, its text after the step", async () => {
    const wire = recordingFetch();
    const p = provider(wire.fetch);
    const stored = toolReferenceMessages(
      { id: "toolu_skill", name: "load_skill" },
      { content: "Loaded skill.", toolReferences: ["set_theme_tokens"] },
      { names: new Set(tools.map((t) => t.name)), deferred: p.deferredToolNames(tools) },
    );
    expect(stored?.followUp).toBeDefined();
    const row = { toolCalls: null, thinkingBlocks: null };
    const history = await buildProviderHistory(
      [
        { role: "user", content: "Build the homepage", toolCallId: null, ...row },
        {
          role: "assistant",
          content: "",
          toolCallId: null,
          ...row,
          responseMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "toolu_skill",
                  toolName: "load_skill",
                  input: { slugs: ["theme-branding"] },
                },
                { type: "tool-call", toolCallId: "toolu_pages", toolName: "build_page", input: {} },
              ],
            },
          ],
        },
        {
          role: "tool",
          content: "Loaded skill.",
          toolCallId: "toolu_skill",
          ...row,
          responseMessages: [stored?.toolMessage, stored?.followUp],
        },
        { role: "tool", content: "built", toolCallId: "toolu_pages", ...row },
      ],
      async () => ({ failed: "no images in this test" }) as const,
    );
    for await (const _ of p.generate({ systemPrompt: "Build the site", messages: history, tools }));
    const body = wire.body();
    const sentTools = body.tools as { name: string; defer_loading?: boolean }[];
    expect(sentTools.find((t) => t.name === "set_theme_tokens")?.defer_loading).toBe(true);
    const messages = body.messages as { role: string; content: unknown }[];
    const last = messages.at(-1) as { role: string; content: Record<string, unknown>[] };
    expect(last.role).toBe("user");
    expect(last.content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(last.content[0]?.tool_use_id).toBe("toolu_skill");
    expect(last.content[0]?.content).toEqual([
      { type: "tool_reference", tool_name: "set_theme_tokens" },
    ]);
    expect(last.content[2]?.text).toBe("Loaded skill.");
  });
});
