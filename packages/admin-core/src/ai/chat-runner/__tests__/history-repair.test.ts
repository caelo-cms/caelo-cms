// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D1 — regression tests for tool_use/tool_result pairing repair.
 *
 * The live failure: the tool-approvals Owner queue appended a tool-role
 * message with the synthetic id `approval-<uuid>`; no assistant
 * tool_use carries that id, so Anthropic 400'd every subsequent call
 * ("unexpected `tool_use_id` found in `tool_result` blocks") and the
 * session wedged permanently. The follow-on damage was assistant
 * messages whose tool_calls never got results because the 400 aborted
 * the turn mid-dispatch ("Tool result is missing for tool call …").
 *
 * Both the pure repair function and its `buildProviderHistory` wiring
 * are covered so the replay path is proven to heal poisoned sessions.
 */

import { describe, expect, it } from "bun:test";

import type { ChatMessageInput } from "../../provider.js";
import { buildProviderHistory, type HistoryMessage } from "../attachments.js";
import { repairToolCallPairing } from "../history-repair.js";

const ORPHAN_ACK_ID = "approval-140eec37-0000-0000-0000-000000000000";

function healthyHistory(): ChatMessageInput[] {
  return [
    { role: "user", content: "delete the stale pages" },
    {
      role: "assistant",
      content: "Queuing the bulk delete.",
      toolCalls: [{ id: "toulu_1", name: "delete_pages_many", arguments: {} }],
    },
    { role: "tool", content: "Queued proposal abc: needs Owner approval", toolCallId: "toulu_1" },
    { role: "assistant", content: "I prepared the proposal — click Approve." },
  ];
}

describe("repairToolCallPairing (run #10 D1)", () => {
  it("leaves a healthy history untouched", () => {
    const input = healthyHistory();
    const r = repairToolCallPairing(input);
    expect(r.messages).toEqual(input);
    expect(r.droppedToolResultIds).toEqual([]);
    expect(r.strippedToolCallIds).toEqual([]);
    expect(r.droppedEmptyAssistantMessages).toBe(0);
  });

  it("drops an orphan approval-ack tool_result (the run #10 killer)", () => {
    const input: ChatMessageInput[] = [
      ...healthyHistory(),
      // The poisoned ack: tool-role message whose id matches no tool_use.
      {
        role: "tool",
        content: "[approved + dispatched by Owner] delete_pages_many: 3 deleted",
        toolCallId: ORPHAN_ACK_ID,
      },
      { role: "user", content: "continue" },
    ];
    const r = repairToolCallPairing(input);
    expect(r.droppedToolResultIds).toEqual([ORPHAN_ACK_ID]);
    expect(r.messages.some((m) => m.toolCallId === ORPHAN_ACK_ID)).toBe(false);
    // Everything else survives, in order.
    expect(r.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  it("strips a tool_use with no tool_result and keeps the message's text", () => {
    const input: ChatMessageInput[] = [
      { role: "user", content: "edit the hero" },
      {
        role: "assistant",
        content: "Editing now.",
        toolCalls: [
          { id: "toulu_answered", name: "edit_module", arguments: {} },
          { id: "toulu_unanswered", name: "edit_module", arguments: {} },
        ],
      },
      // Only the first call ever got its result — the 400 aborted the
      // turn before the second dispatch persisted.
      { role: "tool", content: "ok", toolCallId: "toulu_answered" },
    ];
    const r = repairToolCallPairing(input);
    expect(r.strippedToolCallIds).toEqual(["toulu_unanswered"]);
    const assistant = r.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.map((tc) => tc.id)).toEqual(["toulu_answered"]);
    expect(assistant?.content).toBe("Editing now.");
  });

  it("drops an assistant message left fully empty after stripping", () => {
    const input: ChatMessageInput[] = [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toulu_lost", name: "list_pages", arguments: {} }],
      },
      { role: "user", content: "hello? continue" },
    ];
    const r = repairToolCallPairing(input);
    expect(r.strippedToolCallIds).toEqual(["toulu_lost"]);
    expect(r.droppedEmptyAssistantMessages).toBe(1);
    expect(r.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("keeps only the first tool_result when an id repeats", () => {
    const input: ChatMessageInput[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toulu_dup", name: "edit_module", arguments: {} }],
      },
      { role: "tool", content: "first", toolCallId: "toulu_dup" },
      { role: "tool", content: "second (duplicate)", toolCallId: "toulu_dup" },
    ];
    const r = repairToolCallPairing(input);
    const results = r.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("first");
    expect(r.droppedToolResultIds).toEqual(["toulu_dup"]);
  });

  it("drops a tool message with a missing toolCallId", () => {
    const input: ChatMessageInput[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "stray result with no id" },
    ];
    const r = repairToolCallPairing(input);
    expect(r.messages.map((m) => m.role)).toEqual(["user"]);
    expect(r.droppedToolResultIds).toEqual(["(missing toolCallId)"]);
  });
});

describe("buildProviderHistory runs the repair (poisoned-session replay)", () => {
  const noopLoader = async (): Promise<{ failed: string }> => ({ failed: "not used" });

  it("removes the orphan approval ack and the unanswered tool_use from the replay", async () => {
    const persisted: HistoryMessage[] = [
      {
        role: "user",
        content: "delete the stale pages",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
      },
      {
        role: "assistant",
        content: "Queuing.",
        toolCalls: [{ id: "toulu_1", name: "delete_pages_many", arguments: {} }],
        toolCallId: null,
        thinkingBlocks: null,
      },
      {
        role: "tool",
        content: "Queued proposal abc",
        toolCalls: null,
        toolCallId: "toulu_1",
        thinkingBlocks: null,
      },
      // Poison 1: the approval ack with a synthetic id.
      {
        role: "tool",
        content: "[approved + dispatched by Owner] delete_pages_many: done",
        toolCalls: null,
        toolCallId: ORPHAN_ACK_ID,
        thinkingBlocks: null,
      },
      // Poison 2: a later turn 400'd between persisting the assistant
      // tool_calls and persisting their results.
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toulu_2", name: "list_pages", arguments: {} }],
        toolCallId: null,
        thinkingBlocks: null,
      },
      {
        role: "user",
        content: "continue",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
      },
    ];
    const out = await buildProviderHistory(persisted, noopLoader);
    // The orphan ack is gone.
    expect(out.some((m) => m.toolCallId === ORPHAN_ACK_ID)).toBe(false);
    // The unanswered tool_use is gone (its empty assistant shell too).
    expect(
      out.some((m) => m.toolCalls?.some((tc) => (tc as { id: string }).id === "toulu_2")),
    ).toBe(false);
    // The intact pair survives.
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "toulu_1")).toBe(true);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });
});
