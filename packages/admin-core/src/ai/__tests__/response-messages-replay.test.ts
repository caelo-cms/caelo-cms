// SPDX-License-Identifier: MPL-2.0

/**
 * Option C (2026-07, CLAUDE.md §12) — the SDK's canonical `response.messages`
 * assembly is the history source of truth. An assistant row that carries it
 * replays verbatim (passthrough) instead of being rebuilt from our
 * content/toolCalls/thinkingBlocks — the reconstruction is what dropped the
 * paired tool-search result and 400'd run-B6.
 *
 * These tests lock the two mechanical guarantees:
 *   1. buildProviderHistory turns a `responseMessages`-carrying assistant row
 *      into a `sdkMessages` passthrough entry AND skips the OUR-format pairing
 *      repair (which can't see the tool_use nested inside the opaque SDK
 *      messages and would otherwise strip the matching tool-role row).
 *   2. toSDKMessages splices those SDK messages back verbatim (one history
 *      row → N ModelMessages).
 */

import { describe, expect, it } from "bun:test";
import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";
import { toSDKMessages } from "../providers/_sdk-shared.js";

const noImages = async () => ({ failed: "no loader in this test" }) as const;

/** A stand-in for the SDK's assembled assistant ModelMessage. */
const sdkAssistant = (text: string, toolCallId?: string) => ({
  role: "assistant" as const,
  content: [
    { type: "text" as const, text },
    ...(toolCallId
      ? [
          {
            type: "tool-call" as const,
            toolCallId,
            toolName: "add_module",
            input: { blockName: "footer" },
          },
        ]
      : []),
  ],
});

describe("Option C — response_messages replay (CLAUDE.md §12)", () => {
  it("replays an assistant row's responseMessages as a sdkMessages passthrough", async () => {
    const history: HistoryMessage[] = [
      {
        role: "user",
        content: "add a footer",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
      },
      {
        role: "assistant",
        // These OUR-format fields must be IGNORED in favour of responseMessages.
        content: "on it",
        toolCalls: [{ id: "tc-1", name: "add_module", arguments: {} }],
        thinkingBlocks: [{ thinking: "reasoning", signature: "sig" }],
        responseMessages: [sdkAssistant("on it", "tc-1")],
      },
    ];
    const out = await buildProviderHistory(history, noImages);
    // User row unchanged; assistant row becomes a passthrough entry.
    expect(out).toHaveLength(2);
    expect(out[1]?.sdkMessages).toEqual([sdkAssistant("on it", "tc-1")]);
    // The OUR-format reconstruction fields are NOT set on the passthrough entry.
    expect(out[1]?.toolCalls).toBeUndefined();
    expect(out[1]?.thinkingBlocks).toBeUndefined();
    expect(out[1]?.serverToolCalls).toBeUndefined();
  });

  it("skips the pairing repair so a passthrough tool_use keeps its tool-role result", async () => {
    // The tool_use lives INSIDE the opaque SDK message; the repair can't see
    // it. Before the skip, the paired tool row read as an orphan and got
    // dropped, breaking the very pairing Option C exists to preserve.
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: null,
        thinkingBlocks: null,
        toolCallId: null,
        responseMessages: [sdkAssistant("", "tc-9")],
      },
      {
        role: "tool",
        content: "footer added",
        toolCalls: null,
        thinkingBlocks: null,
        toolCallId: "tc-9",
      },
    ];
    const out = await buildProviderHistory(history, noImages);
    // Both survive: the passthrough assistant + its tool result.
    expect(out).toHaveLength(2);
    expect(out[0]?.sdkMessages).toBeDefined();
    expect(out[1]?.role).toBe("tool");
    expect(out[1]?.toolCallId).toBe("tc-9");
  });

  it("expands one passthrough entry into its N SDK ModelMessages", () => {
    const sdk = [sdkAssistant("first", "tc-a"), sdkAssistant("second")];
    const mapped = toSDKMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ignored", sdkMessages: sdk },
    ]);
    // user (1) + the two spliced SDK messages (2) = 3.
    expect(mapped).toHaveLength(3);
    expect(mapped[0]).toEqual({ role: "user", content: "hi" });
    expect(mapped[1]).toEqual(sdk[0]);
    expect(mapped[2]).toEqual(sdk[1]);
  });

  it("leaves non-passthrough entries on the reconstruction path (1:1)", () => {
    const mapped = toSDKMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });
});
