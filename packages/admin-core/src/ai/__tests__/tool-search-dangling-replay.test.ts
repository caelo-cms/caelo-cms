// SPDX-License-Identifier: MPL-2.0

/**
 * Deterministic replay-side ACCEPTANCE test — tool-search deferred-result
 * 400 wedge (issue #442), flipped green by the SDK-loop migration.
 *
 * Companion to `tool-search-deferred-live.test.ts` (the live-API evidence
 * run). This file needs NO network and NO key: it feeds the verbatim shape
 * persisted in the wedged dev session (cms_admin.chat_messages, session
 * 57c2f0f5, assistant turn 2026-08-06 07:47:28 — reasoning → providerExecuted
 * tool-call `tool_search_tool_bm25` WITHOUT its tool-result → client
 * tool-call) through the REAL replay path:
 *
 *   chat_messages rows → buildProviderHistory (incl. the issue-#442
 *     replay-time strip in history-repair.ts) → toSDKMessages passthrough
 *     → streamText → @ai-sdk/anthropic request builder → captured HTTP body
 *
 * and proves, byte-level, that the continuation request no longer carries
 * the unpaired `server_tool_use` block that the Anthropic API rejected with:
 *
 *   messages.N: tool_search_tool_bm25 tool use with id srvtoolu_… was found
 *   without a corresponding tool_search_tool_bm25_tool_result block
 *
 * Pre-#442 this file's REGRESSION assertion was the deterministic proof of
 * the wedge (EXPECTED FAIL); the migration's replay-time strip
 * (`repairToolCallPairing`) heals the poisoned passthrough row on every
 * load, so the wedge class is unreachable for already-poisoned sessions
 * too — the unwedge path of issue #442 section D.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createAnthropic } from "@ai-sdk/anthropic";

import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";
import type { ProviderEvent, ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

/* ------------------------------------------------------------------ */
/* The persisted defective shape (verbatim structure from the dev DB)  */
/* ------------------------------------------------------------------ */

// The tool-search threshold is forced for these replays; restore the
// ambient value so co-running test files see their own default.
let savedThreshold: string | undefined;
beforeAll(() => {
  savedThreshold = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
});
afterAll(() => {
  if (savedThreshold === undefined) delete process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
  else process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD = savedThreshold;
});

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

/** The persisted rows of the wedged session after the client tool ran —
 * exactly what chat_messages holds and buildProviderHistory replays. */
const PERSISTED_ROWS: HistoryMessage[] = [
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

/** Replay the persisted rows through the REAL path (buildProviderHistory →
 * provider.generate) with a fetch that captures the outgoing Anthropic
 * request body and answers with the production 400. Returns the captured
 * body + the provider events. */
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

  const noImages = async () => ({ failed: "no loader in this test" }) as const;
  const rows = await buildProviderHistory(PERSISTED_ROWS, noImages);
  const events: ProviderEvent[] = [];
  for await (const e of provider.generate({
    systemPrompt: "test",
    messages: rows,
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

describe("tool-search dangling replay — deterministic wire-level acceptance (#442)", () => {
  it("REGRESSION: Option-C replay of a deferred-dangling turn must not emit an unpaired server_tool_use", async () => {
    const { body } = await replayContinuation();
    const blocks = findAssistantBlocks(body);
    const serverToolUse = blocks.find((b) => b.type === "server_tool_use" && b.id === SRV_ID);
    const pairedResult = blocks.find(
      (b) => b.type === "tool_search_tool_result" && b.tool_use_id === SRV_ID,
    );
    // The invariant the Anthropic API enforces: a replayed tool-search
    // server_tool_use needs its result block. The issue-#442 replay-time
    // strip removes the dangling persisted call, so the request is clean.
    expect(serverToolUse === undefined || pairedResult !== undefined).toBe(true);
  });

  it("the healed continuation request keeps the client pairing and drops only the dangling search call", async () => {
    const { body } = await replayContinuation();
    const blocks = findAssistantBlocks(body);
    // The dangling server_tool_use is stripped from the wire…
    expect(blocks.some((b) => b.type === "server_tool_use" && b.id === SRV_ID)).toBe(false);
    // …while the client tool_use (whose tool_result row exists) survives.
    expect(blocks.some((b) => b.type === "tool_use" && b.id === CLIENT_ID)).toBe(true);
  });

  it("a provider 400 still surfaces as the error event the bug channel records", async () => {
    // The canned fetch answers 400 regardless of the request body — this
    // pins the surfacing contract the wedge relied on for diagnosis: a
    // provider rejection becomes a ProviderEvent error, never a silent stop.
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

  it("history repair heals the poisoned passthrough row LOUDLY (issue #442 unwedge)", async () => {
    const noImages = async () => ({ failed: "no loader in this test" }) as const;
    let healedIds: string[] = [];
    const out = await buildProviderHistory(PERSISTED_ROWS, noImages, (repair) => {
      healedIds = repair.strippedServerToolCallIds;
    });
    expect(out).toHaveLength(3);
    // The dangling providerExecuted call is stripped from inside the
    // passthrough assembly; reasoning + the client tool-call survive so the
    // turn still replays.
    const assistant = out[1]?.sdkMessages?.[0] as
      | { content?: { type?: string; toolCallId?: string }[] }
      | undefined;
    const parts = assistant?.content ?? [];
    expect(parts.some((p) => p.toolCallId === SRV_ID)).toBe(false);
    expect(parts.some((p) => p.toolCallId === CLIENT_ID)).toBe(true);
    expect(parts.some((p) => p.type === "reasoning")).toBe(true);
    // Loud, never silent: the repair reports the healed id so the caller
    // (runChatTurn) files the per-session bug-report row.
    expect(healedIds).toEqual([SRV_ID]);
  });
});
