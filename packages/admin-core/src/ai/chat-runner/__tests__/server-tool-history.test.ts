// SPDX-License-Identifier: MPL-2.0

/**
 * Tool Search round-trip, persistence half. Server-executed search
 * calls persist in the same tool_calls jsonb as client calls (tagged
 * `serverExecuted: true`); buildProviderHistory must split them back
 * out so (a) the provider replays them as server_tool_use blocks and
 * (b) the pairing repair never strips them as "unanswered tool_use"
 * (they legitimately have no tool-role result — the API answered them
 * inline).
 */

import { describe, expect, it } from "bun:test";
import { buildProviderHistory } from "../attachments.js";

const noImages = async (): Promise<{ failed: string }> => ({ failed: "not expected" });

describe("buildProviderHistory — server tool calls", () => {
  it("splits serverExecuted rows into serverToolCalls and keeps client calls dispatch-paired", async () => {
    const out = await buildProviderHistory(
      [
        {
          role: "user",
          content: "add a footer",
          toolCalls: null,
          toolCallId: null,
          thinkingBlocks: null,
        },
        {
          role: "assistant",
          content: "searching…",
          toolCalls: [
            {
              id: "srv1",
              name: "tool_search_tool_bm25",
              arguments: { query: "layout css" },
              result: [{ type: "tool_reference", toolName: "edit_layout" }],
              serverExecuted: true,
            },
            { id: "c1", name: "edit_layout", arguments: { slug: "site-default" } },
          ],
          toolCallId: null,
          thinkingBlocks: null,
        },
        { role: "tool", content: "ok", toolCalls: null, toolCallId: "c1", thinkingBlocks: null },
      ],
      noImages,
    );
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(["c1"]);
    expect(assistant?.serverToolCalls?.map((c) => c.id)).toEqual(["srv1"]);
    expect(assistant?.serverToolCalls?.[0]?.result).toEqual([
      { type: "tool_reference", toolName: "edit_layout" },
    ]);
  });

  it("does NOT strip a server call as an unanswered tool_use (no tool-role result exists for it)", async () => {
    // Search-only assistant turn: no client call, no tool-role message.
    // Before the split, repairToolCallPairing treated srv1 as a dangling
    // tool_use and dropped the whole message — losing the discovered-
    // tools context the docs say to replay.
    const out = await buildProviderHistory(
      [
        { role: "user", content: "hi", toolCalls: null, toolCallId: null, thinkingBlocks: null },
        {
          role: "assistant",
          content: "let me look for a tool",
          toolCalls: [
            {
              id: "srv1",
              name: "tool_search_tool_bm25",
              arguments: { query: "redirects" },
              result: [],
              serverExecuted: true,
            },
          ],
          toolCallId: null,
          thinkingBlocks: null,
        },
      ],
      noImages,
    );
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.serverToolCalls?.length).toBe(1);
    expect(assistant?.toolCalls).toBeUndefined();
  });
});
