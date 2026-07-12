// SPDX-License-Identifier: MPL-2.0
/**
 * Regression: Sonnet 5's adaptive thinking can close a reasoning block
 * with empty text. Replaying such a block 400s at the API ("each
 * thinking block must contain thinking") and permanently kills the
 * session (hit live in migration run #7, 2026-07-12). Empty blocks are
 * dropped at persistence (streaming.ts) AND filtered at replay for
 * sessions poisoned before the fix.
 */
import { describe, expect, it } from "bun:test";
import { buildProviderHistory, type HistoryMessage } from "../attachments.js";

const noImages = async (): Promise<never> => {
  throw new Error("no attachments in this test");
};

describe("buildProviderHistory thinking-block hygiene", () => {
  it("filters empty thinking blocks out of the replay", async () => {
    const messages: HistoryMessage[] = [
      { role: "user", content: "hi", toolCalls: null, toolCallId: null, thinkingBlocks: null },
      {
        role: "assistant",
        content: "ok",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: [
          { thinking: "", signature: "sig-empty" },
          { thinking: "real reasoning", signature: "sig-real" },
        ],
      },
    ];
    const out = await buildProviderHistory(messages, noImages);
    expect(out[1]?.thinkingBlocks).toEqual([{ thinking: "real reasoning", signature: "sig-real" }]);
  });

  it("omits thinkingBlocks entirely when every block is empty", async () => {
    const messages: HistoryMessage[] = [
      {
        role: "assistant",
        content: "ok",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: [{ thinking: "", signature: "sig-empty" }],
      },
    ];
    const out = await buildProviderHistory(messages, noImages);
    expect(out[0]?.thinkingBlocks).toBeUndefined();
  });
});
