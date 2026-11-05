// SPDX-License-Identifier: MPL-2.0

/**
 * #1479 — which unanswered tool searches a continuation request may still
 * carry: only the last assistant row's, and only while nothing but tool
 * results follows it. Past that boundary the API refuses the request.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessageInput } from "../../provider.js";
import { settleDeferredServerCalls } from "../history-repair.js";

const search = (id: string) => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "tool_search_tool_bm25",
  providerExecuted: true,
  input: { query: "x" },
});
const client = (id: string) => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "find_media",
  input: {},
});
const reasoning = {
  type: "reasoning",
  text: "",
  providerOptions: { anthropic: { signature: "s" } },
};

const assistant = (content: unknown[]): ChatMessageInput => ({
  role: "assistant",
  content: "",
  sdkMessages: [{ role: "assistant", content }],
});
const toolRow = (id: string): ChatMessageInput => ({ role: "tool", content: "ok", toolCallId: id });
const user: ChatMessageInput = { role: "user", content: "follows the step" };
const opening: ChatMessageInput = { role: "user", content: "go" };

describe("settleDeferredServerCalls (#1479)", () => {
  test("a request ending at the boundary comes back untouched, by identity", () => {
    const messages = [opening, assistant([reasoning, search("s1"), client("c1")]), toolRow("c1")];
    const out = settleDeferredServerCalls(messages);
    expect(out.messages).toBe(messages);
    expect(out.strippedIds).toEqual([]);
  });

  test("a row after the tool results ends the deferral: the call goes, the rest stays", () => {
    const messages = [
      opening,
      assistant([reasoning, search("s1"), client("c1")]),
      toolRow("c1"),
      user,
    ];
    const out = settleDeferredServerCalls(messages);
    expect(out.strippedIds).toEqual(["s1"]);
    expect(out.lastAssistantSdkMessages).toEqual([
      { role: "assistant", content: [reasoning, client("c1")] },
    ]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  test("a stored tool row carrying its follow-up counts as past the boundary", () => {
    const stored: ChatMessageInput = {
      role: "tool",
      content: "text",
      sdkMessages: [
        { role: "tool", content: [] },
        { role: "user", content: "text" },
      ],
    };
    const out = settleDeferredServerCalls([
      opening,
      assistant([search("s1"), client("c1")]),
      stored,
    ]);
    expect(out.strippedIds).toEqual(["s1"]);
  });

  test("an answered search stays wherever it sits", () => {
    const messages = [
      opening,
      assistant([search("s1"), client("c1")]),
      toolRow("c1"),
      assistant([
        { type: "tool-result", toolCallId: "s1", toolName: "tool_search_tool_bm25", output: {} },
        { type: "text", text: "go on" },
      ]),
      user,
    ];
    expect(settleDeferredServerCalls(messages).messages).toBe(messages);
  });

  test("a step left with nothing but thinking is dropped: the API refuses such a turn too", () => {
    const out = settleDeferredServerCalls([opening, assistant([reasoning, search("s1")]), user]);
    expect(out.strippedIds).toEqual(["s1"]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(out.lastAssistantSdkMessages).toBeUndefined();
  });
});
