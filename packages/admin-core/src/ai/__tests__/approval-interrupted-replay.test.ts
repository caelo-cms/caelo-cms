// SPDX-License-Identifier: MPL-2.0

/**
 * Regression — the chat wedge behind the red real-AI homepage scenario
 * (main since 10dab598, run 37747902426).
 *
 * The AI called the gated `accept_quality_findings`; the approval resumed
 * the turn, the SDK applied the acceptance, and the operator navigated away
 * before the resumed step finished, so the step's slice (with the tool
 * result) was never persisted. The stored transcript was left with the
 * gated tool-call (+ its approval request, and — in production — the
 * persisted approval) but no result. On the operator's next message the
 * SDK refused to build the prompt:
 *
 *   AI_MissingToolResultsError: Tool result is missing for tool call toolu_…
 *
 * and every later turn failed the same way. The replay-time repair now
 * answers such a call with an "interrupted" result once the conversation
 * has moved on, so the chat continues; a pending approval at the END of
 * the history (the legitimate resume point) is left for the SDK to run.
 *
 * Same harness as tool-search-dangling-replay.test.ts: persisted rows →
 * buildProviderHistory → the REAL AnthropicProvider/streamText request
 * builder → captured HTTP body. No network, no key.
 */

import { describe, expect, it } from "bun:test";

import { createAnthropic } from "@ai-sdk/anthropic";

import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";
import type { HistoryRepairResult } from "../chat-runner/history-repair.js";
import type { ProviderEvent, ToolDefinition } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";

const GATED_ID = "toolu_01SFznbmaRPo25pXcqG2q2c4";
const APPROVAL_ID = "aitxt-approval-1";

const TOOLS: ToolDefinition[] = [
  {
    name: "accept_quality_findings",
    description: "Accept quality findings (approval-gated).",
    inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    alwaysLoaded: true,
  },
];

const row = (r: Partial<HistoryMessage> & Pick<HistoryMessage, "role" | "content">) =>
  ({
    toolCalls: null,
    toolCallId: null,
    thinkingBlocks: null,
    ...r,
  }) as HistoryMessage;

/** The paused assistant step as Option C persisted it. */
const PAUSED_STEP = row({
  role: "assistant",
  content: "Accepting the remaining finding.",
  responseMessages: [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Accepting the remaining finding." },
        {
          type: "tool-call",
          toolCallId: GATED_ID,
          toolName: "accept_quality_findings",
          input: { reason: "performance on the CI runner" },
        },
        { type: "tool-approval-request", approvalId: APPROVAL_ID, toolCallId: GATED_ID },
      ],
    },
  ],
});

/** The persisted approval (persistApprovalResponse). */
const APPROVAL = row({
  role: "tool",
  content: "[approval granted]",
  responseMessages: [
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: APPROVAL_ID, approved: true }],
    },
  ],
});

const FIRST_USER = row({ role: "user", content: "Quality check found 1 problem." });
const NEXT_USER = row({
  role: "user",
  content: "Update the hero headline to 'Ship faster with Caelo'.",
});

interface WireBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
interface WireMessage {
  role?: string;
  content?: WireBlock[] | string;
}

async function replay(
  rows: HistoryMessage[],
): Promise<{ body: { messages?: WireMessage[] } | undefined; events: ProviderEvent[] }> {
  let body: { messages?: WireMessage[] } | undefined;
  const captureFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "offline" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const model = createAnthropic({ apiKey: "offline-test", fetch: captureFetch })(
    "claude-sonnet-4-6",
  );
  const provider = new AnthropicProvider({
    apiKey: "offline-test",
    model: "claude-sonnet-4-6",
    _modelOverride: model,
  });
  const noImages = async () => ({ failed: "no loader in this test" }) as const;
  const messages = await buildProviderHistory(rows, noImages);
  const events: ProviderEvent[] = [];
  for await (const e of provider.generate({
    systemPrompt: "test",
    messages,
    tools: TOOLS,
    maxTokens: 200,
  })) {
    events.push(e);
  }
  return { body, events };
}

function resultFor(body: { messages?: WireMessage[] } | undefined): WireBlock | undefined {
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    const hit = m.content.find((b) => b.type === "tool_result" && b.tool_use_id === GATED_ID);
    if (hit) return hit;
  }
  return undefined;
}

const missingResult = (events: ProviderEvent[]) =>
  events.some((e) => e.kind === "error" && e.message.includes("Tool result is missing"));

describe("an approved gated call interrupted before its result was saved", () => {
  it("does not wedge the next turn: the call is answered as interrupted (production transcript)", async () => {
    const { body, events } = await replay([FIRST_USER, PAUSED_STEP, APPROVAL, NEXT_USER]);
    expect(missingResult(events)).toBe(false);
    const result = resultFor(body);
    expect(result?.is_error).toBe(true);
    expect(JSON.stringify(result?.content)).toContain("check the current state");
  });

  it("an unanswered approval the operator moved past is answered as not applied", async () => {
    const { body, events } = await replay([FIRST_USER, PAUSED_STEP, NEXT_USER]);
    expect(missingResult(events)).toBe(false);
    expect(JSON.stringify(resultFor(body)?.content)).toContain("was not applied");
  });

  it("reports the heal so the caller files it (approved ones may have been applied)", async () => {
    let repair: HistoryRepairResult | undefined;
    const noImages = async () => ({ failed: "no loader in this test" }) as const;
    await buildProviderHistory([FIRST_USER, PAUSED_STEP, APPROVAL, NEXT_USER], noImages, (r) => {
      repair = r;
    });
    expect(repair?.answeredInterruptedCalls).toEqual([
      { toolCallId: GATED_ID, toolName: "accept_quality_findings", approved: true },
    ]);
  });

  it("leaves the legitimate resume point alone: an approval at the end of the history", async () => {
    let repair: HistoryRepairResult | undefined;
    const noImages = async () => ({ failed: "no loader in this test" }) as const;
    const out = await buildProviderHistory([FIRST_USER, PAUSED_STEP, APPROVAL], noImages, (r) => {
      repair = r;
    });
    expect(repair).toBeUndefined();
    expect(out).toHaveLength(3);
  });
});
