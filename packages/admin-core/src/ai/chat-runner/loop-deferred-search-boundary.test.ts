// SPDX-License-Identifier: MPL-2.0

/**
 * #1479 — a tool search paired with a client call in one response, followed
 * by anything but that call's tool result.
 *
 * The API defers such a search's result to the next response, and accepts
 * the unanswered `server_tool_use` only when the request ends right at the
 * tool_result boundary (#442). Any other content in that user message and it
 * validates the history as finished and refuses it. Release gate run
 * 42073895917 (`claude-sonnet-5-5`) recorded both sides:
 *
 *   - chat 08eb81ab: thinking + search + load_skill, the skill text after
 *     the tool result → 400 "messages.1: `tool_search_tool_bm25` tool use …
 *     was found without a corresponding `tool_search_tool_result` block",
 *     the turn dead on its second step.
 *   - chat bc570df6: thinking + find_media + search, a plain tool result →
 *     accepted, the result arrived at the start of the next response.
 *
 * The real provider and the real SDK loop run; the fetch stands in for the
 * API and enforces that rule, so the refused request fails here as it did on
 * the wire. Query API and tools are fixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import type { ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { ToolResult } from "../tools/dispatch.js";
import type { ToolRegistry } from "../tools/index.js";
import { runToolLoop } from "./loop.js";
import type { UsageAccumulator } from "./streaming.js";
import type { ChatRunnerOptions, ClientEvent, RunChatTurnFn } from "./types.js";

const MODEL = "claude-sonnet-5-5";
const SEARCH_ID = "srvtoolu_014fBhwbT8KDmMuwaBWgK4Kb";
const CLIENT_ID = "toolu_01JoTFhgieSC97byL1S6ZKb4";
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
};

const finish = (stopReason: string): Record<string, unknown>[] => [
  { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

/** A tool block streamed in the recorded order: start, one input delta, stop. */
const toolBlock = (index: number, start: Record<string, unknown>, input: unknown) => [
  { type: "content_block_start", index, content_block: { ...start, input: {} } },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  },
  { type: "content_block_stop", index },
];

/** Thinking (omitted display, as on 5.5), then the search, then the client call. */
function deferringResponse(clientTool: string): string {
  return sse([
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "c2ln" },
    },
    { type: "content_block_stop", index: 0 },
    ...toolBlock(
      1,
      { type: "server_tool_use", id: SEARCH_ID, name: "tool_search_tool_bm25" },
      { query: "generate_image AI image generation" },
    ),
    ...toolBlock(
      2,
      { type: "tool_use", id: CLIENT_ID, name: clientTool, caller: { type: "direct" } },
      {},
    ),
    ...finish("tool_use"),
  ]);
}

const textBlock = (index: number, text: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];

const closingResponse = sse([messageStart, ...textBlock(0, "done"), ...finish("end_turn")]);

/** The deferred result at the head of the next response, as chat bc570df6 got it. */
const deliveringResponse = sse([
  messageStart,
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_search_tool_result",
      tool_use_id: SEARCH_ID,
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "long_tail_0" }],
      },
    },
  },
  { type: "content_block_stop", index: 0 },
  ...textBlock(1, "done"),
  ...finish("end_turn"),
]);

interface WireMessage {
  role: string;
  content: string | { type: string; id?: string; tool_use_id?: string; [k: string]: unknown }[];
}

const blocks = (m: WireMessage | undefined) => (Array.isArray(m?.content) ? m.content : []);

/** The API's rule, see the file header. Returns the refusal, or null. */
function refusal(messages: readonly WireMessage[]): string | null {
  const all = messages.flatMap(blocks);
  const unanswered = all
    .filter((b) => b.type === "server_tool_use")
    .map((b) => b.id ?? "")
    .filter((id) => !all.some((b) => b.type === "tool_search_tool_result" && b.tool_use_id === id));
  if (unanswered.length === 0) return null;
  const last = blocks(messages.at(-1));
  if (last.length > 0 && last.every((b) => b.type === "tool_result")) return null;
  return (
    `messages.1: \`tool_search_tool_bm25\` tool use with id \`${unanswered[0]}\` ` +
    "was found without a corresponding `tool_search_tool_result` block"
  );
}

function fakeApi(firstResponse: string, nextResponse: string) {
  const requests: WireMessage[][] = [];
  const stub = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
    requests.push(body.messages);
    const refused = refusal(body.messages);
    if (refused) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: refused },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(requests.length === 1 ? firstResponse : nextResponse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { stub, requests };
}

function fixtureQueryApi() {
  const stamps: { messageId: string; responseMessages: unknown[] }[] = [];
  const registry = new OperationRegistry();
  const define = (name: string, handler: (input: Record<string, unknown>) => object) =>
    registry.register(
      defineOperation({
        name,
        readScope: "request",
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.looseObject({}),
        output: z.looseObject({}),
        handler: async (_ctx, input) => ok(handler(input as Record<string, unknown>)),
      }),
    );
  let rows = 0;
  define("chat.append_message", () => {
    rows += 1;
    return { messageId: `msg-${rows}` };
  });
  define("chat.set_response_messages", (input) => {
    stamps.push(input as (typeof stamps)[number]);
    return { updated: true };
  });
  define("chat.lookup_tool_result", () => ({ cached: null }));
  define("chat.cache_tool_result", () => ({}));
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter, stamps };
}

const tool = (name: string, alwaysLoaded: boolean): ToolDefinition => ({
  name,
  description: `fixture ${name}`,
  inputSchema: { type: "object", properties: {} },
  alwaysLoaded,
});

// Above the tool-search threshold, so the provider defers the long tail.
const TOOLS: ToolDefinition[] = [
  tool("load_skill", true),
  tool("find_media", true),
  tool("screenshot_page", true),
  ...Array.from({ length: 12 }, (_, i) => tool(`long_tail_${i}`, false)),
];

async function runTurn(
  api: ReturnType<typeof fakeApi>,
  clientTool: string,
  toolResult: ToolResult,
) {
  const fixture = fixtureQueryApi();
  const provider = new AnthropicProvider({
    apiKey: "offline-fixture",
    model: MODEL,
    toolSearch: "bm25",
    _modelOverride: createAnthropic({ apiKey: "offline-fixture", fetch: api.stub })(MODEL),
  });
  const ctx: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "req-1" };
  const usage: UsageAccumulator = { totalIn: 0, totalOut: 0, totalCached: 0 };
  const gen = runToolLoop({
    registry: fixture.registry,
    adapter: fixture.adapter,
    humanCtx: ctx,
    aiCtxWithBranch: { ...ctx, actorId: "ai-1", actorKind: "ai" },
    provider,
    tools: {
      dispatch: async (name: string) =>
        name === clientTool ? toolResult : { ok: false, content: "unknown" },
    } as unknown as ToolRegistry,
    options: {} as ChatRunnerOptions,
    runChatTurn: (() => {
      throw new Error("no subagents in this test");
    }) as unknown as RunChatTurnFn,
    chatSessionId: "cs-deferred",
    chatBranchId: "cb-1",
    abortSignal: undefined,
    systemChunks: "",
    filteredTools: TOOLS,
    initialMessages: [{ role: "user", content: "Generate a mountain logo." }],
    compactionThresholdTokens: 600_000,
    maxLoops: 5,
    maxOutputTokens: 4096,
    temperature: undefined,
    thinkingBudget: null,
    usage,
    costCapMicrocents: undefined,
    inputCost: 2,
    outputCost: 10,
  });
  const events: ClientEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, loop: step.value, stamps: fixture.stamps };
    events.push(step.value);
  }
}

/** The tool calls of a stored step slice. */
function storedCalls(stamp: { responseMessages: unknown[] } | undefined): string[] {
  const parts = (stamp?.responseMessages ?? []).flatMap(
    (m) => (m as { content?: { type?: string; toolCallId?: string }[] }).content ?? [],
  );
  return parts.filter((p) => p.type === "tool-call").map((p) => p.toolCallId ?? "");
}

let savedThreshold: string | undefined;
beforeAll(() => {
  savedThreshold = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
  process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";
});
afterAll(() => {
  if (savedThreshold === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
  else process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = savedThreshold;
});

describe("runToolLoop — a deferred tool search past its boundary (#1479)", () => {
  it("load_skill next to a search: the turn survives, skill text and references arrive", async () => {
    const api = fakeApi(deferringResponse("load_skill"), closingResponse);
    const { loop, stamps } = await runTurn(api, "load_skill", {
      ok: true,
      content: 'Loaded skill "manage-media".',
      toolReferences: ["long_tail_0"],
    });

    expect(loop.succeeded).toBe(true);
    expect(api.requests).toHaveLength(2);
    const continuation = api.requests[1];
    expect(blocks(continuation?.at(-2)).map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(blocks(continuation?.at(-1)).map((b) => b.type)).toEqual(["tool_result", "text"]);
    // The stored step matches what this request sent. Storing the search
    // would strip it at the next turn's replay instead: an edit of history
    // that invalidates every newer thinking block, and a false wedge report.
    expect(storedCalls(stamps.at(-1))).toEqual([CLIENT_ID]);
  });

  it("an image result next to a search: the image reaches the model", async () => {
    const api = fakeApi(deferringResponse("screenshot_page"), closingResponse);
    const { loop } = await runTurn(api, "screenshot_page", {
      ok: true,
      content: "Screenshot captured.",
      image: { base64: ONE_PIXEL_PNG, mediaType: "image/png" },
    });

    expect(loop.succeeded).toBe(true);
    const continuation = api.requests[1];
    expect(blocks(continuation?.at(-2)).some((b) => b.type === "server_tool_use")).toBe(false);
    expect(blocks(continuation?.at(-1)).some((b) => b.type === "image")).toBe(true);
  });

  it("a plain result at the boundary keeps the search, and its result arrives", async () => {
    const api = fakeApi(deferringResponse("find_media"), deliveringResponse);
    const { loop, stamps } = await runTurn(api, "find_media", {
      ok: true,
      content: "No media matched.",
    });

    expect(loop.succeeded).toBe(true);
    expect(api.requests).toHaveLength(2);
    expect(blocks(api.requests[1]?.at(-2)).map((b) => b.type)).toEqual([
      "thinking",
      "server_tool_use",
      "tool_use",
    ]);
    expect(stamps.flatMap(storedCalls)).toContain(SEARCH_ID);
  });
});
