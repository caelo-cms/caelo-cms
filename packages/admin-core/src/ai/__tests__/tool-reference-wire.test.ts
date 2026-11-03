// SPDX-License-Identifier: MPL-2.0

/**
 * #991 — what load_skill's tool references look like on the Anthropic wire.
 * The chat-runner stores them as the AI SDK's custom content part
 * (`toolReferenceMessage`); the request must carry them as
 * `{type: "tool_reference", tool_name}` blocks inside the tool_result, next
 * to the result text, and every referenced tool must be in `tools` with
 * `defer_loading` — a reference to a tool the request lacks is a 400
 * ("Tool reference '…' not found in available tools"). The SDK request
 * builder runs for real; the fetch is stubbed, nothing leaves the process.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { toolReferenceMessage } from "../chat-runner/tool-dispatch.js";
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

  test("a referencing tool result reaches the API as text + tool_reference blocks", async () => {
    const wire = recordingFetch();
    const p = provider(wire.fetch);
    const message = toolReferenceMessage(
      { id: "toolu_skill", name: "load_skill" },
      { content: "Loaded skill.", toolReferences: ["set_theme_tokens"] },
      { names: new Set(tools.map((t) => t.name)), deferred: p.deferredToolNames(tools) },
    );
    expect(message).toBeDefined();
    for await (const _ of p.generate({
      systemPrompt: "Build the site",
      messages: [
        { role: "user", content: "Build the homepage" },
        {
          role: "assistant",
          content: "",
          sdkMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "toolu_skill",
                  toolName: "load_skill",
                  input: { slugs: ["theme-branding"] },
                },
              ],
            },
          ],
        },
        { role: "tool", content: "Loaded skill.", sdkMessages: [message] },
      ],
      tools,
    }));
    const body = wire.body();
    const sentTools = body.tools as { name: string; defer_loading?: boolean }[];
    expect(sentTools.find((t) => t.name === "set_theme_tokens")?.defer_loading).toBe(true);
    const messages = body.messages as { role: string; content: unknown }[];
    const results = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => (b as { type?: string }).type === "tool_result") as {
      tool_use_id: string;
      content: unknown;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.tool_use_id).toBe("toolu_skill");
    const blocks = results[0]?.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_reference"]);
    expect(blocks[1]).toEqual({ type: "tool_reference", tool_name: "set_theme_tokens" });
  });
});
