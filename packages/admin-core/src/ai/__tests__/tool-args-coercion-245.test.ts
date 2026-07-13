// SPDX-License-Identifier: MPL-2.0

/**
 * issue #245 root-cause regression — stringified tool-call args must reach
 * the chat-runner already correctly typed.
 *
 * Root cause: `buildSDKTools` handed the AI SDK a bare `jsonSchema(...)`
 * with no `validate` function. The SDK's `safeValidateTypes`
 * short-circuits to `{ success: true, value }` whenever `validate == null`,
 * so it performed ZERO parse-time type enforcement and passed the model's
 * raw `JSON.parse` output straight through as the tool-call `.input`. A turn
 * where the model emitted a quoted scalar (`"position":"2"`, F17) or a
 * JSON-encoded object-in-a-string (`"values":"{…}"`, F11/F12) delivered that
 * stringified value unchanged to dispatch, where the strict Zod parse
 * rejected it.
 *
 * The fix attaches an inputSchema-guided coercing `validate` so the SDK
 * repairs the encoding at parse time. These tests drive a tool call through
 * the REAL SDK stream (via MockLanguageModelV3) and assert the emitted
 * `tool-call` ProviderEvent carries typed args — i.e. the repair happens at
 * the provider boundary, before dispatch, which is exactly the layer #245
 * asked us to root-cause. Without the `validate`, both assertions fail
 * (args arrive as `"2"` / the raw JSON string).
 */

import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { GenerateInput, ProviderEvent } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

/** Mirrors the provider-facing shape derived from `fork_placement_content`. */
const FORK_TOOL: GenerateInput["tools"][number] = {
  name: "fork_placement_content",
  description: "fork a placement",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position"],
    properties: {
      pageId: { type: "string" },
      blockName: { type: "string" },
      position: { type: "integer", minimum: 0 },
    },
  },
};

/** Mirrors the provider-facing shape derived from `set_content_instance_values`. */
const SET_VALUES_TOOL: GenerateInput["tools"][number] = {
  name: "set_content_instance_values",
  description: "set instance values",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "values"],
    properties: {
      id: { type: "string" },
      values: { type: "object", additionalProperties: true },
    },
  },
};

/**
 * Run one tool call through the SDK translation layer. `rawInput` is the raw
 * argument TEXT the model emitted (as the provider delivers it) — the thing
 * the fix must repair.
 */
async function toolCallArgsFor(
  tool: GenerateInput["tools"][number],
  rawInput: string,
): Promise<unknown> {
  const mock = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tu_1", toolName: tool.name },
            { type: "tool-input-delta", id: "tu_1", delta: rawInput },
            { type: "tool-input-end", id: "tu_1" },
            { type: "tool-call", toolCallId: "tu_1", toolName: tool.name, input: rawInput },
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
    tools: [tool],
  })) {
    events.push(e);
  }
  const call = events.find((e) => e.kind === "tool-call");
  expect(call?.kind).toBe("tool-call");
  return call && call.kind === "tool-call" ? call.arguments : undefined;
}

describe("issue #245 — provider bridge delivers typed tool-call args", () => {
  it('coerces a stringified integer scalar (F17: position: "2")', async () => {
    const args = await toolCallArgsFor(
      FORK_TOOL,
      '{"pageId":"p1","blockName":"header","position":"2"}',
    );
    expect(args).toEqual({ pageId: "p1", blockName: "header", position: 2 });
  });

  it("parses a JSON-encoded object delivered as a string (F11/F12: values)", async () => {
    const args = await toolCallArgsFor(
      SET_VALUES_TOOL,
      '{"id":"c1","values":"{\\"hero_title\\":\\"Hi\\"}"}',
    );
    expect(args).toEqual({ id: "c1", values: { hero_title: "Hi" } });
  });

  it("leaves already-typed args untouched (no false coercion)", async () => {
    const args = await toolCallArgsFor(
      FORK_TOOL,
      '{"pageId":"p1","blockName":"header","position":3}',
    );
    expect(args).toEqual({ pageId: "p1", blockName: "header", position: 3 });
  });
});
