// SPDX-License-Identifier: MPL-2.0

/**
 * The AI SDK `repairToolCall` hook rewrites a call to a retired tool name
 * (or a renamed bulk wrapper key) into the live tool's call BEFORE the SDK
 * reports NoSuchToolError — driven through the REAL `streamText` loop via
 * MockLanguageModelV3, so the test proves the hook is wired, not only that
 * the helper maps names.
 */

import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { GenerateInput, ProviderEvent } from "../provider.js";
import { repairRetiredToolCall } from "../providers/_sdk-shared.js";
import { AnthropicProvider } from "../providers/anthropic.js";

const ALT_MANY: GenerateInput["tools"][number] = {
  name: "set_media_alt_many",
  description: "alt text",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { type: "object" } } },
  },
};

const REDIRECTS: GenerateInput["tools"][number] = {
  name: "bulk_create_redirects",
  description: "redirects",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { type: "object" } } },
  },
};

/** Stream one model tool call through the provider; return the emitted tool-call events. */
async function emittedCalls(
  tools: GenerateInput["tools"],
  toolName: string,
  rawInput: string,
): Promise<{ name: string; arguments: unknown }[]> {
  const mock = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "tu_1", toolName, input: rawInput },
            {
              type: "finish",
              finishReason: { unified: "tool-calls" },
              usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            },
          ]) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    }),
  });
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-opus-4-7",
    _modelOverride: mock,
  });
  const events: ProviderEvent[] = [];
  for await (const e of provider.generate({
    systemPrompt: "x",
    messages: [{ role: "user", content: "hi" }],
    tools,
  })) {
    events.push(e);
  }
  return events.flatMap((e) =>
    e.kind === "tool-call" ? [{ name: e.name, arguments: e.arguments }] : [],
  );
}

describe("repairToolCall wiring (real streamText loop)", () => {
  it("a retired name reaches the run as the live bulk tool with adapted args", async () => {
    const calls = await emittedCalls(
      [ALT_MANY],
      "set_media_alt",
      '{"assetId":"a1","alt":"A red bicycle"}',
    );
    expect(calls).toEqual([
      {
        name: "set_media_alt_many",
        arguments: { items: [{ assetId: "a1", alt: "A red bicycle" }] },
      },
    ]);
  });

  it("a retired name whose target is not in this turn's tools is not repaired", async () => {
    const calls = await emittedCalls([REDIRECTS], "set_media_alt", '{"assetId":"a1","alt":"x"}');
    expect(calls.some((c) => c.name === "set_media_alt_many")).toBe(false);
  });
});

describe("repairRetiredToolCall", () => {
  const tools = { set_media_alt_many: {}, bulk_create_redirects: {} };
  const call = (toolName: string, input: string) => ({
    type: "tool-call" as const,
    toolCallId: "tu_1",
    toolName,
    input,
  });

  it("keeps every other field of the call", () => {
    expect(repairRetiredToolCall(call("set_media_alt", '{"assetId":"a"}'), tools)).toEqual({
      type: "tool-call",
      toolCallId: "tu_1",
      toolName: "set_media_alt_many",
      input: '{"items":[{"assetId":"a"}]}',
    });
  });

  it("renames an old wrapper key on a live tool", () => {
    const r = repairRetiredToolCall(call("bulk_create_redirects", '{"redirects":[]}'), tools);
    expect(r?.toolName).toBe("bulk_create_redirects");
    expect(JSON.parse(r?.input ?? "{}")).toEqual({ items: [] });
  });

  it("returns null for nothing to repair, unknown names and non-JSON input", () => {
    expect(repairRetiredToolCall(call("bulk_create_redirects", '{"items":[]}'), tools)).toBeNull();
    expect(repairRetiredToolCall(call("no_such_tool", "{}"), tools)).toBeNull();
    expect(repairRetiredToolCall(call("set_media_alt", "{not json"), tools)).toBeNull();
  });
});
