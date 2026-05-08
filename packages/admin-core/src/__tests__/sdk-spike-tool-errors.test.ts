// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.71 — Vercel AI SDK spike preflight: verify the SDK exposes
 * enough information for Caelo to differentiate three tool-error
 * classes in the chat-runner's tool-result construction:
 *
 *  (1) Zod input fail — model emits malformed args; Caelo's dispatcher
 *      catches at the schema layer and returns ok:false, content:
 *      "invalid arguments: ...". The AI sees the validation
 *      message and retries with corrected args.
 *
 *  (2) Tool handler throws (v0.2.52 fix) — caught at dispatch.ts:1203
 *      level, surfaced as ok:false, content: "tool error: ...".
 *      AI sees the runtime error message and recovers.
 *
 *  (3) Tool returns structured failure — handler returns
 *      `{ok: false, content: "<op-shaped error>"}`. AI sees the
 *      domain-specific failure (e.g. "module slug already taken").
 *
 * The SDK's `tool()` helper has an `execute` callback that returns
 * the tool's result. We need to confirm:
 *  - When execute throws, the SDK surfaces the error in a way our
 *    chat-runner equivalent can capture (so we map to class 2).
 *  - When execute returns a structured `{ok: false, ...}` value,
 *    that structure flows back to the model unchanged (class 3).
 *  - The model's malformed-input case is observable BEFORE execute
 *    runs (class 1) — the SDK's input schema validation rejects.
 *
 * If the SDK collapses these into one undifferentiated "tool
 * failed" event, the v0.3.0 migration regresses v0.2.52's
 * tool-error recovery work. That's a blocker.
 */

import { describe, expect, it } from "bun:test";
import { streamText, tool } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";

function streamOf<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("AI SDK spike — tool error differentiation (v0.2.71 preflight)", () => {
  it("surfaces a thrown handler error as a tool-error stream part with the original message", async () => {
    let executeCalled = false;
    const throwingTool = tool({
      description: "always throws",
      inputSchema: z.object({}),
      execute: async () => {
        executeCalled = true;
        throw new Error("boom from inside the tool handler");
      },
    });

    // Mock model issues a tool-call for `throwingTool`, then waits for
    // the result (tool execution happens between turns). The SDK
    // executes the tool, captures the throw, and surfaces it as an
    // event.
    const mock = new MockLanguageModelV2({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "tc1", toolName: "throwingTool" },
          { type: "tool-input-delta", id: "tc1", delta: "{}" },
          { type: "tool-input-end", id: "tc1" },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "throwingTool",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          },
        ]),
      }),
    });

    const result = streamText({
      model: mock,
      messages: [{ role: "user", content: "use the throwing tool" }],
      tools: { throwingTool },
    });

    const events: { type: string; [k: string]: unknown }[] = [];
    for await (const ev of result.fullStream) {
      events.push(ev as (typeof events)[number]);
    }

    expect(executeCalled).toBe(true);

    // The SDK should surface a `tool-error` part with the original
    // error message so we can build a "tool error: ..." tool_result
    // for the AI's next turn.
    const toolErrorEvent = events.find((e) => e.type === "tool-error");
    expect(toolErrorEvent).toBeDefined();
    if (!toolErrorEvent) throw new Error("no tool-error event");
    const errMsg =
      toolErrorEvent.error instanceof Error
        ? toolErrorEvent.error.message
        : String(toolErrorEvent.error);
    expect(errMsg).toContain("boom from inside the tool handler");
  });

  it("preserves a structured {ok:false, ...} return value verbatim through to the model's next turn input", async () => {
    let executeCalled = false;
    const structuredFailTool = tool({
      description: "always returns a structured failure",
      inputSchema: z.object({}),
      execute: async () => {
        executeCalled = true;
        // Simulating a domain-specific structured failure that
        // Caelo's existing tool handlers return today.
        return { ok: false, content: "module slug already taken" };
      },
    });

    // Two-loop scenario: first call emits a tool_use; SDK runs the
    // tool; second call MUST receive the tool result in its prompt.
    let secondCallSeenPrompt: unknown = null;
    let firstCallDone = false;
    const mock = new MockLanguageModelV2({
      doStream: async ({ prompt }) => {
        if (firstCallDone) {
          secondCallSeenPrompt = prompt;
          return {
            stream: streamOf([
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "noted." },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ]),
          };
        }
        firstCallDone = true;
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "tc1", toolName: "structuredFailTool" },
            { type: "tool-input-delta", id: "tc1", delta: "{}" },
            { type: "tool-input-end", id: "tc1" },
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "structuredFailTool",
              input: "{}",
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            },
          ]),
        };
      },
    });

    const result = streamText({
      model: mock,
      messages: [{ role: "user", content: "try the structured-fail tool" }],
      tools: { structuredFailTool },
      stopWhen: ({ steps }) => steps.length >= 2,
    });
    for await (const _ of result.fullStream) {
      // drain
    }

    expect(executeCalled).toBe(true);
    expect(firstCallDone).toBe(true);
    expect(secondCallSeenPrompt).not.toBeNull();

    // The second call's prompt should contain a tool-result message
    // carrying our structured {ok: false, ...} payload as the result.
    // The SDK shapes this as a tool message with `output` carrying the
    // returned value; we just need to confirm the structured payload
    // round-trips intact.
    const promptArr = secondCallSeenPrompt as { role: string; content: unknown }[];
    const toolMsg = promptArr.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (!toolMsg) throw new Error("no tool message in second-call prompt");
    const toolContent = toolMsg.content as {
      type: string;
      output?: { type: string; value?: unknown };
    }[];
    const toolResultPart = toolContent.find((c) => c.type === "tool-result");
    expect(toolResultPart).toBeDefined();
    // The structured payload should be reachable. Different SDK
    // versions wrap the value differently (output.value for json
    // outputs, output for text); accept either shape.
    const value =
      (toolResultPart?.output as { type?: string; value?: unknown } | undefined)?.value ??
      toolResultPart?.output;
    expect(value).toEqual({ ok: false, content: "module slug already taken" });
  });
});
