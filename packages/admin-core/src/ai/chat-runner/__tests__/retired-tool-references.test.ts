// SPDX-License-Identifier: MPL-2.0

/**
 * A persisted tool-search result that loaded a since-retired tool must not
 * wedge the chat. Anthropic rejects a replayed `tool_reference` whose tool is
 * not in the request ("Tool reference 'set_media_alt' not found in available
 * tools" — verified against the live API 2026-10-26), so buildProviderHistory
 * rewrites references to retired names onto their live replacement. Driven
 * through the real replay path down to the captured request body.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createAnthropic } from "@ai-sdk/anthropic";

import type { ToolDefinition } from "../../provider.js";
import { AnthropicProvider } from "../../providers/anthropic.js";
import { buildProviderHistory, type HistoryMessage } from "../attachments.js";
import { rewriteRetiredToolReferences } from "../retired-tool-references.js";

let savedThreshold: string | undefined;
beforeAll(() => {
  savedThreshold = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
});
afterAll(() => {
  if (savedThreshold === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
  else process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = savedThreshold;
});

const SRV_ID = "srvtoolu_01RetiredRef";
const CLIENT_ID = "toolu_01RetiredRef";
const noImages = async () => ({ failed: "no loader in this test" }) as const;

/** An Option-C passthrough turn: search loads set_media_alt, then calls it. */
const ROWS: HistoryMessage[] = [
  {
    role: "user",
    content: "set the alt text of the hero image",
    toolCalls: null,
    toolCallId: null,
    thinkingBlocks: null,
  },
  {
    role: "assistant",
    content: "",
    toolCalls: null,
    toolCallId: null,
    thinkingBlocks: null,
    responseMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: SRV_ID,
            toolName: "tool_search_tool_bm25",
            input: { query: "media alt text" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: SRV_ID,
            toolName: "tool_search_tool_bm25",
            output: {
              type: "json",
              value: [{ type: "tool_reference", toolName: "set_media_alt" }],
            },
          },
          {
            type: "tool-call",
            toolCallId: CLIENT_ID,
            toolName: "set_media_alt",
            input: { mediaId: "m1", alt: "A cat on a sofa" },
          },
        ],
      },
    ],
  },
  { role: "tool", content: "ok", toolCalls: null, toolCallId: CLIENT_ID, thinkingBlocks: null },
];

const TOOLS: ToolDefinition[] = [
  {
    name: "list_pages",
    description: "List pages.",
    inputSchema: { type: "object", properties: {} },
    alwaysLoaded: true,
  },
  {
    name: "set_media_alt_many",
    description: "Set alt text for media items.",
    inputSchema: { type: "object", properties: { items: { type: "array" } } },
  },
  ...Array.from({ length: 6 }, (_v, i) => ({
    name: `filler_tool_${i}`,
    description: `Filler tool ${i} for threshold engagement.`,
    inputSchema: { type: "object" as const },
  })),
];

interface WireBlock {
  type?: string;
  content?: { tool_references?: { tool_name?: string }[] };
}

async function captureReplayBody(): Promise<{
  messages?: { role?: string; content?: WireBlock[] | string }[];
}> {
  process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";
  let captured: { messages?: { role?: string; content?: WireBlock[] | string }[] } | undefined;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "captured" },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const model = createAnthropic({ apiKey: "offline-test", fetch: captureFetch })(
    "claude-sonnet-4-6",
  );
  const provider = new AnthropicProvider({
    apiKey: "offline-test",
    model: "claude-sonnet-4-6",
    toolSearch: "bm25",
    _modelOverride: model,
  });
  const rows = await buildProviderHistory(ROWS, noImages);
  for await (const _e of provider.generate({
    systemPrompt: "test",
    messages: rows,
    tools: TOOLS,
    maxTokens: 100,
  })) {
    // drain
  }
  if (!captured) throw new Error("no request captured");
  return captured;
}

describe("retired tool references in replayed tool-search results", () => {
  it("the replayed request references the live replacement, never the retired tool", async () => {
    const body = await captureReplayBody();
    const refs = (body.messages ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_search_tool_result")
      .flatMap((b) => b.content?.tool_references ?? [])
      .map((r) => r.tool_name);
    expect(refs).toEqual(["set_media_alt_many"]);
  });

  it("rewrites both persisted shapes and reports every rewrite", () => {
    const { messages, rewrites } = rewriteRetiredToolReferences([
      {
        role: "assistant",
        content: "",
        serverToolCalls: [
          {
            id: "s1",
            name: "tool_search_tool_bm25",
            arguments: {},
            result: [{ type: "tool_reference", toolName: "reorder_module" }],
          },
        ],
      },
      { role: "assistant", content: "", sdkMessages: ROWS[1]?.responseMessages },
    ] as never);
    expect(rewrites).toEqual([
      { from: "reorder_module", to: "move_module" },
      { from: "set_media_alt", to: "set_media_alt_many" },
    ]);
    expect(JSON.stringify(messages)).not.toContain(
      '{"type":"tool_reference","toolName":"set_media_alt"}',
    );
    // The client tool-call keeps its historical name and args (the API accepts it).
    expect(JSON.stringify(messages)).toContain('"toolName":"set_media_alt","input"');
  });

  it("leaves live references and unrelated messages untouched (by identity)", () => {
    const live = {
      role: "assistant",
      content: "x",
      sdkMessages: [{ type: "tool_reference", toolName: "list_pages" }],
    };
    const { messages, rewrites } = rewriteRetiredToolReferences([live] as never);
    expect(rewrites).toEqual([]);
    expect(messages[0]).toBe(live as never);
  });
});
