// SPDX-License-Identifier: MPL-2.0

/**
 * Deterministic replay-side proof — tool-search deferred-result 400 wedge.
 *
 * Companion to `tool-search-deferred-live.test.ts` (the live-API evidence
 * run). This file needs NO network and NO key: it feeds the verbatim shape
 * persisted in the wedged dev session (cms_admin.chat_messages, session
 * 57c2f0f5, assistant turn 2026-08-06 07:47:28 — reasoning → providerExecuted
 * tool-call `tool_search_tool_bm25` WITHOUT its tool-result → client
 * tool-call) through the REAL Option-C replay path:
 *
 *   ChatMessageInput.sdkMessages passthrough (toSDKMessages)
 *     → streamText → @ai-sdk/anthropic convertToAnthropicMessagesPrompt
 *     → captured HTTP request body
 *
 * and proves, byte-level, that the continuation request carries a
 * `server_tool_use` block with NO paired `tool_search_tool_result` — the
 * exact request the Anthropic API rejected with:
 *
 *   messages.N: tool_search_tool_bm25 tool use with id srvtoolu_… was found
 *   without a corresponding tool_search_tool_bm25_tool_result block
 *
 * The capture-fetch then returns that 400 verbatim and the test asserts our
 * provider surfaces it as the error event the chat-runner persisted to
 * ai_bug_reports — closing the loop on the production wedge.
 *
 * Assertion roles:
 *   - "REGRESSION" test: asserts the INVARIANT (no dangling server_tool_use
 *     in the outgoing request). EXPECTED TO FAIL on current code — that
 *     failure is the deterministic proof. It flips to green when the fix
 *     (SDK-loop migration; or interim deferred-continuation handling)
 *     lands.
 *   - "documents" tests: assert TODAY's defective behavior so the root
 *     cause stays pinned; they are inverted/removed by the fix commit.
 */

import { describe, expect, it } from "bun:test";

import { createAnthropic } from "@ai-sdk/anthropic";

import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";
import type { ChatMessageInput, ProviderEvent, ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

/* ------------------------------------------------------------------ */
/* The persisted defective shape (verbatim structure from the dev DB)  */
/* ------------------------------------------------------------------ */

const SRV_ID = "srvtoolu_011oLJ6QxEAGLCkcyBe6qU5A";
const CLIENT_ID = "toolu_011mTHGmy59t2EzVkrAUMyUo";

/**
 * Mirror of the wedged row's `response_messages`: ONE assistant ModelMessage
 * whose content is reasoning → providerExecuted tool-call (no result) →
 * client tool-call. Field names follow the SDK's ModelMessage assembly, as
 * persisted by Option C (verified against the dev DB dump in the issue).
 */
const DEFECTIVE_SDK_MESSAGES: unknown[] = [
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "The search may find a mapping tool; capturing the page in parallel.",
        providerOptions: { anthropic: { signature: "test-signature-not-verified-offline" } },
      },
      {
        type: "tool-call",
        toolCallId: SRV_ID,
        toolName: "tool_search_tool_bm25",
        input: { query: "map external page types" },
        providerExecuted: true,
      },
      {
        type: "tool-call",
        toolCallId: CLIENT_ID,
        toolName: "screenshot_external_page",
        input: { url: "https://example.com/" },
      },
    ],
  },
];

const PRODUCTION_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: `messages.1: tool_search_tool_bm25 tool use with id ${SRV_ID} was found without a corresponding tool_search_tool_bm25_tool_result block`,
  },
};

const TOOLS: ToolDefinition[] = [
  {
    name: "screenshot_external_page",
    description: "Capture a screenshot of an external page.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    alwaysLoaded: true,
  },
  // Enough deferred filler to engage the tool-search transform (threshold
  // is forced to 5 below), so the continuation request declares the search
  // tool exactly as production does.
  ...Array.from({ length: 6 }, (_v, i) => ({
    name: `filler_tool_${i}`,
    description: `Filler tool ${i} for threshold engagement.`,
    inputSchema: { type: "object" as const },
  })),
];

/** The chat-runner's continuation rows after dispatching the client tool —
 * exactly what loop.ts persists and attachments.ts replays. */
const CONTINUATION_ROWS: ChatMessageInput[] = [
  { role: "user", content: "map the external page and grab a screenshot" },
  { role: "assistant", content: "", sdkMessages: DEFECTIVE_SDK_MESSAGES },
  { role: "tool", content: "screenshot stored: 1280x800 png", toolCallId: CLIENT_ID },
];

/* ------------------------------------------------------------------ */
/* Capture harness                                                     */
/* ------------------------------------------------------------------ */

interface AnthropicWireBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
}
interface AnthropicWireMessage {
  role?: string;
  content?: AnthropicWireBlock[] | string;
}

/** Run one provider.generate over the continuation rows with a fetch that
 * captures the outgoing Anthropic request body and answers with the
 * production 400. Returns the captured body + the provider events. */
async function replayContinuation(): Promise<{
  body: { messages?: AnthropicWireMessage[] } | undefined;
  events: ProviderEvent[];
}> {
  process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = "5";
  let captured: { messages?: AnthropicWireMessage[] } | undefined;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      captured = JSON.parse(init.body) as { messages?: AnthropicWireMessage[] };
    }
    return new Response(JSON.stringify(PRODUCTION_400), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
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

  const events: ProviderEvent[] = [];
  for await (const e of provider.generate({
    systemPrompt: "test",
    messages: CONTINUATION_ROWS,
    tools: TOOLS,
    maxTokens: 400,
  })) {
    events.push(e);
  }
  return { body: captured, events };
}

function findAssistantBlocks(
  body: { messages?: AnthropicWireMessage[] } | undefined,
): AnthropicWireBlock[] {
  const out: AnthropicWireBlock[] = [];
  for (const m of body?.messages ?? []) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    out.push(...m.content);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("tool-search dangling replay — deterministic wire-level proof", () => {
  it("REGRESSION: Option-C replay of a deferred-dangling turn must not emit an unpaired server_tool_use [EXPECTED FAIL until the loop fix lands]", async () => {
    const { body } = await replayContinuation();
    const blocks = findAssistantBlocks(body);
    const serverToolUse = blocks.find((b) => b.type === "server_tool_use" && b.id === SRV_ID);
    const pairedResult = blocks.find(
      (b) => b.type === "tool_search_tool_result" && b.tool_use_id === SRV_ID,
    );
    // The invariant the Anthropic API enforces: a replayed tool-search
    // server_tool_use needs its result block. Current code replays the
    // persisted dangling call verbatim, so this fails — deterministically
    // reproducing the wedge's 400-triggering request.
    expect(serverToolUse === undefined || pairedResult !== undefined).toBe(true);
  });

  it("documents today's defect: the continuation request carries the dangling server_tool_use verbatim", async () => {
    const { body } = await replayContinuation();
    const blocks = findAssistantBlocks(body);
    // Faithful replay (Option C working as designed): the persisted call
    // block IS on the wire…
    expect(blocks.some((b) => b.type === "server_tool_use" && b.id === SRV_ID)).toBe(true);
    // …the client tool_use and its tool_result pairing survive…
    expect(blocks.some((b) => b.type === "tool_use" && b.id === CLIENT_ID)).toBe(true);
    // …but no tool_search_tool_result exists anywhere in the request.
    expect(blocks.some((b) => b.type === "tool_search_tool_result")).toBe(false);
  });

  it("documents today's defect: the API 400 surfaces as the provider error event the wedge logged", async () => {
    const { events } = await replayContinuation();
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(
        (e) =>
          e.kind === "error" &&
          e.message.includes("without a corresponding tool_search_tool_bm25_tool_result"),
      ),
    ).toBe(true);
  });

  it("history repair does not touch the poisoned passthrough row (why the wedge is permanent)", async () => {
    const history: HistoryMessage[] = [
      {
        role: "user",
        content: "map the external page and grab a screenshot",
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
        responseMessages: [...DEFECTIVE_SDK_MESSAGES],
      },
      {
        role: "tool",
        content: "screenshot stored: 1280x800 png",
        toolCalls: null,
        thinkingBlocks: null,
        toolCallId: CLIENT_ID,
      },
    ];
    const noImages = async () => ({ failed: "no loader in this test" }) as const;
    const out = await buildProviderHistory(history, noImages);
    expect(out).toHaveLength(3);
    // The passthrough survives verbatim — the dangling providerExecuted call
    // inside is invisible to history-repair (history-repair.ts sdk-row skip),
    // so every future turn of the session replays the poison. Unwedging
    // existing sessions therefore needs an explicit repair migration.
    expect(out[1]?.sdkMessages).toEqual([...DEFECTIVE_SDK_MESSAGES]);
  });
});
