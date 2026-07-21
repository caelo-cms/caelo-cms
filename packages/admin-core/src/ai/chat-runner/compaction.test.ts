// SPDX-License-Identifier: MPL-2.0

/**
 * issue #261 — unit tests for the pure history-compaction functions:
 * size estimator, prompt-too-long detection, and the two-stage
 * compactor's invariants (pairing integrity, never-touch-recent,
 * truncation-marker format, latest-user/assistant preservation).
 */

import { describe, expect, it } from "bun:test";

import type { ChatMessageInput } from "../provider.js";
import {
  buildSpanDigest,
  COMPACTION_RECENT_TOKENS_DEFAULT,
  COMPACTION_TARGET_TOKENS_DEFAULT,
  COMPACTION_THRESHOLD_TOKENS_DEFAULT,
  compactHistory,
  estimateHistoryTokens,
  estimateMessageTokens,
  isPromptTooLongError,
  KEEP_RECENT_MESSAGES,
  MIN_RECENT_MESSAGES,
  parsePromptTooLongLimit,
  recentTailCount,
  resolveCompactionRecentTokens,
  resolveCompactionTargetTokens,
  resolveCompactionThresholdTokens,
} from "./compaction.js";

/** The exact provider message that killed run #7 (issue #261). */
const RUN_7_ERROR = "prompt is too long: 1202876 tokens > 1000000 maximum";

function user(content: string): ChatMessageInput {
  return { role: "user", content };
}
function assistant(content: string, toolCallIds: string[] = []): ChatMessageInput {
  return {
    role: "assistant",
    content,
    ...(toolCallIds.length > 0
      ? { toolCalls: toolCallIds.map((id) => ({ id, name: `tool_${id}`, arguments: {} })) }
      : {}),
  };
}
function toolResult(toolCallId: string, content: string): ChatMessageInput {
  return { role: "tool", content, toolCallId };
}

/**
 * Pairing-integrity checker: every kept tool result must be preceded
 * (anywhere earlier in the history) by an assistant message carrying
 * the matching tool_use id. An orphaned result is a provider-side 400.
 */
function assertPairingIntact(messages: readonly ChatMessageInput[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "tool") continue;
    const owner = messages
      .slice(0, i)
      .some(
        (prev) =>
          prev.role === "assistant" && (prev.toolCalls ?? []).some((c) => c.id === m.toolCallId),
      );
    expect(owner).toBe(true);
  }
}

describe("estimateMessageTokens", () => {
  it("estimates chars/4 on plain content, rounded up", () => {
    expect(estimateMessageTokens(user("a".repeat(400)))).toBe(100);
    expect(estimateMessageTokens(user("abc"))).toBe(1);
  });

  it("counts tool-call JSON and thinking text, but not signatures", () => {
    const bare = assistant("hi");
    const withTools = assistant("hi", ["t1"]);
    expect(estimateMessageTokens(withTools)).toBeGreaterThan(estimateMessageTokens(bare));

    const thinking: ChatMessageInput = {
      role: "assistant",
      content: "hi",
      thinkingBlocks: [{ thinking: "x".repeat(400), signature: "s".repeat(4000) }],
    };
    // 400 thinking chars = 100 tokens; the 4000-char signature adds 0.
    expect(estimateMessageTokens(thinking)).toBe(estimateMessageTokens(bare) + 100);
  });

  it("counts images as a flat constant, not base64 chars/4", () => {
    const withImage: ChatMessageInput = {
      role: "user",
      content: "",
      additionalContent: [{ type: "image", base64: "A".repeat(1_000_000), mediaType: "image/png" }],
    };
    expect(estimateMessageTokens(withImage)).toBe(1600);
  });

  it("sums across the history", () => {
    const msgs = [user("a".repeat(400)), user("b".repeat(800))];
    expect(estimateHistoryTokens(msgs)).toBe(300);
  });
});

describe("isPromptTooLongError / parsePromptTooLongLimit", () => {
  it("matches the run #7 Anthropic message and extracts the ceiling", () => {
    expect(isPromptTooLongError(RUN_7_ERROR)).toBe(true);
    expect(parsePromptTooLongLimit(RUN_7_ERROR)).toBe(1_000_000);
  });

  it("matches OpenAI-style context-length messages", () => {
    expect(isPromptTooLongError("This model's maximum context length is 128000 tokens.")).toBe(
      true,
    );
    expect(isPromptTooLongError("error code: context_length_exceeded")).toBe(true);
  });

  it("does not match unrelated provider errors", () => {
    expect(isPromptTooLongError("rate limited, retry after 60s")).toBe(false);
    expect(isPromptTooLongError("overloaded_error")).toBe(false);
    expect(parsePromptTooLongLimit("rate limited")).toBeNull();
  });
});

describe("resolveCompactionThresholdTokens", () => {
  it("defaults when the env var is unset or empty", () => {
    expect(resolveCompactionThresholdTokens({})).toBe(COMPACTION_THRESHOLD_TOKENS_DEFAULT);
    expect(resolveCompactionThresholdTokens({ CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS: "" })).toBe(
      COMPACTION_THRESHOLD_TOKENS_DEFAULT,
    );
  });

  it("honours a numeric override", () => {
    expect(
      resolveCompactionThresholdTokens({ CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS: "250000" }),
    ).toBe(250_000);
  });

  it("throws loudly on a garbage override (no silent fallback pre-1.0)", () => {
    expect(() =>
      resolveCompactionThresholdTokens({ CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS: "lots" }),
    ).toThrow(/CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS/);
    expect(() =>
      resolveCompactionThresholdTokens({ CAELO_CHAT_COMPACTION_THRESHOLD_TOKENS: "-5" }),
    ).toThrow(/positive integer/);
  });

  it("trigger fires far above the landing target (fire late, drop hard)", () => {
    // The whole point of the retune: trigger and target are separate, and
    // the trigger sits well above the target so one compaction buys a long
    // cache-hit runway before the next one.
    expect(COMPACTION_THRESHOLD_TOKENS_DEFAULT).toBeGreaterThan(COMPACTION_TARGET_TOKENS_DEFAULT * 3);
    expect(COMPACTION_TARGET_TOKENS_DEFAULT).toBeGreaterThan(COMPACTION_RECENT_TOKENS_DEFAULT);
  });
});

describe("resolveCompactionTargetTokens / resolveCompactionRecentTokens", () => {
  it("default, override, and loud failure mirror the threshold resolver", () => {
    expect(resolveCompactionTargetTokens({})).toBe(COMPACTION_TARGET_TOKENS_DEFAULT);
    expect(resolveCompactionTargetTokens({ CAELO_CHAT_COMPACTION_TARGET_TOKENS: "123000" })).toBe(
      123_000,
    );
    expect(() =>
      resolveCompactionTargetTokens({ CAELO_CHAT_COMPACTION_TARGET_TOKENS: "nope" }),
    ).toThrow(/positive integer/);

    expect(resolveCompactionRecentTokens({})).toBe(COMPACTION_RECENT_TOKENS_DEFAULT);
    expect(resolveCompactionRecentTokens({ CAELO_CHAT_COMPACTION_RECENT_TOKENS: "80000" })).toBe(
      80_000,
    );
    expect(() =>
      resolveCompactionRecentTokens({ CAELO_CHAT_COMPACTION_RECENT_TOKENS: "-1" }),
    ).toThrow(/positive integer/);
  });
});

describe("recentTailCount", () => {
  it("returns a token-bounded tail, not a fixed message count", () => {
    // 20 small messages (~2 tokens each); a 10-token budget admits ~5.
    const msgs = Array.from({ length: 20 }, (_, i) => user(`m${i}`));
    const n = recentTailCount(msgs, 10);
    expect(n).toBeGreaterThanOrEqual(MIN_RECENT_MESSAGES);
    expect(n).toBeLessThan(msgs.length);
  });

  it("keeps at least MIN_RECENT_MESSAGES even when the last message alone busts the budget", () => {
    const msgs = [user("a"), user("b"), user("c"), user("d"), toolResult("t", "X".repeat(8000))];
    expect(recentTailCount(msgs, 5)).toBe(MIN_RECENT_MESSAGES);
  });

  it("never exceeds the history length", () => {
    const msgs = [user("a"), user("b")];
    expect(recentTailCount(msgs, 1_000_000)).toBe(2);
  });

  it("pushes a fresh oversized dump OUT of the protected tail", () => {
    // A huge result near the front must fall outside a small recent
    // budget, so the ceiling pass is free to truncate it. Tail is long
    // enough (10 small messages) that the pairing floor does not bind.
    const dump = toolResult("t-old", "H".repeat(400_000));
    const tail = Array.from({ length: 10 }, (_, i) => user(`step ${i}`));
    const msgs = [user("start"), assistant("read", ["t-old"]), dump, ...tail];
    const keep = recentTailCount(msgs, 2_000);
    const firstProtectedIdx = msgs.length - keep;
    expect(firstProtectedIdx).toBeGreaterThan(2); // index 2 = the dump, now eligible
  });
});

describe("compactHistory — aggressive default landing (fire late, drop hard)", () => {
  it("collapses a ~800K-real history to well under the ~200K-real target, recent tail verbatim", () => {
    // Build a long history: 40 old tool dumps (~10K est tokens each) plus
    // a short recent tail the model is actively working in.
    const msgs: ChatMessageInput[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push(assistant(`step ${i}`, [`t-${i}`]));
      msgs.push(toolResult(`t-${i}`, `dump ${i}\n${"<div>x</div>".repeat(8000)}`));
    }
    const recentPrompt = "please continue with the pricing page and keep the header";
    msgs.push(user(recentPrompt));
    msgs.push(assistant("on it"));

    const before = estimateHistoryTokens(msgs);
    expect(before).toBeGreaterThan(COMPACTION_THRESHOLD_TOKENS_DEFAULT);

    const keepRecent = recentTailCount(msgs, COMPACTION_RECENT_TOKENS_DEFAULT);
    const r = compactHistory(msgs, {
      targetTokens: COMPACTION_TARGET_TOKENS_DEFAULT,
      keepRecentMessages: keepRecent,
      toolResultHeadChars: 500,
    });

    // Landed at or below the target, a big drop from the trigger.
    expect(r.estimatedTokensAfter).toBeLessThanOrEqual(COMPACTION_TARGET_TOKENS_DEFAULT);
    expect(r.estimatedTokensAfter).toBeLessThan(before / 2);
    // The recent operator turn survived verbatim.
    expect(r.messages.some((m) => m.content.includes(recentPrompt))).toBe(true);
    assertPairingIntact(r.messages);
  });
});

describe("compactHistory — stage 1 (tool-result truncation)", () => {
  it("is a no-op when already under target", () => {
    const msgs = [user("hello"), assistant("hi")];
    const r = compactHistory(msgs, {
      targetTokens: 1000,
      keepRecentMessages: KEEP_RECENT_MESSAGES,
      toolResultHeadChars: 500,
    });
    expect(r.messages).toEqual(msgs);
    expect(r.toolResultsTruncated).toBe(0);
    expect(r.summarizedMessages).toBe(0);
    expect(r.estimatedTokensAfter).toBe(r.estimatedTokensBefore);
  });

  it("truncates the oldest tool result first, with the exact marker format", () => {
    const bigOld = "H".repeat(40_000);
    const bigNewer = "J".repeat(40_000);
    const msgs = [
      user("migrate the site"),
      assistant("on it", ["t1"]),
      toolResult("t1", bigOld),
      assistant("next", ["t2"]),
      toolResult("t2", bigNewer),
      // 10 protected tail messages.
      ...Array.from({ length: 10 }, (_, i) => user(`tail ${i}`)),
    ];
    // Truncating ONE 40k dump is enough to get under this target.
    const target = estimateHistoryTokens(msgs) - 5000;
    const r = compactHistory(msgs, {
      targetTokens: target,
      keepRecentMessages: 10,
      toolResultHeadChars: 500,
    });
    const first = r.messages[2];
    const second = r.messages[4];
    expect(first?.content).toBe(`${"H".repeat(500)}\n[truncated: ${40_000 - 500} chars]`);
    expect(second?.content).toBe(bigNewer); // newer result untouched — oldest first
    expect(r.toolResultsTruncated).toBe(1);
    expect(r.summarizedMessages).toBe(0);
    expect(r.estimatedTokensAfter).toBeLessThanOrEqual(target);
    assertPairingIntact(r.messages);
  });

  it("never touches the most recent keepRecentMessages messages", () => {
    const bigRecent = "R".repeat(80_000);
    const msgs = [
      user("start"),
      assistant("ok", ["t1"]),
      toolResult("t1", bigRecent), // inside the protected tail (12 msgs, keep 10)
      ...Array.from({ length: 9 }, (_, i) => user(`tail ${i}`)),
    ];
    const r = compactHistory(msgs, {
      targetTokens: 1, // impossible target — would truncate everything allowed
      keepRecentMessages: 10,
      toolResultHeadChars: 500,
    });
    // The huge tool result is within the last 10 → must survive verbatim.
    const kept = r.messages.find((m) => m.role === "tool");
    expect(kept?.content).toBe(bigRecent);
  });

  it("skips already-truncated results instead of re-truncating", () => {
    const once = compactHistory(
      [
        user("go"),
        assistant("ok", ["t1"]),
        toolResult("t1", "X".repeat(10_000)),
        ...Array.from({ length: 10 }, (_, i) => user(`tail ${i}`)),
      ],
      { targetTokens: 100, keepRecentMessages: 10, toolResultHeadChars: 500 },
    );
    const twice = compactHistory(once.messages, {
      targetTokens: 1,
      keepRecentMessages: 10,
      toolResultHeadChars: 500,
    });
    expect(twice.toolResultsTruncated).toBe(0);
  });
});

describe("compactHistory — stage 2 (span digest)", () => {
  function longHistory(): ChatMessageInput[] {
    const msgs: ChatMessageInput[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(user(`instruction ${i}: ${"u".repeat(2000)}`));
      msgs.push(assistant(`working on ${i}`, [`t${i}`]));
      msgs.push(toolResult(`t${i}`, `result ${i}: ${"r".repeat(2000)}`));
    }
    msgs.push(user("final instruction"));
    return msgs;
  }

  it("folds the oldest span into one digest and keeps pairing intact", () => {
    const msgs = longHistory();
    const r = compactHistory(msgs, {
      targetTokens: 5000,
      keepRecentMessages: 10,
      toolResultHeadChars: 200,
    });
    expect(r.summarizedMessages).toBeGreaterThan(1);
    const digest = r.messages[0];
    expect(digest?.role).toBe("user");
    expect(digest?.content).toContain("History compacted");
    expect(digest?.content).toContain(`${r.summarizedMessages} earliest`);
    // Digest preserves the tool-name trail for the folded span.
    expect(digest?.content).toContain("tools: tool_t0");
    // First kept message after the digest is never an orphaned tool result.
    expect(r.messages[1]?.role).not.toBe("tool");
    assertPairingIntact(r.messages);
    // Message count shrank to digest + kept tail.
    expect(r.messages.length).toBe(msgs.length - r.summarizedMessages + 1);
  });

  it("keeps the latest user message even when tool spam pushed it out of the tail", () => {
    // Operator message followed by 15 assistant/tool pairs — the latest
    // user message sits outside the recent-10 window.
    const msgs: ChatMessageInput[] = [
      user("old task"),
      assistant("done"),
      user("THE CURRENT INSTRUCTION"),
    ];
    for (let i = 0; i < 8; i++) {
      msgs.push(assistant(`step ${i}`, [`t${i}`]));
      msgs.push(toolResult(`t${i}`, `out ${i}: ${"x".repeat(4000)}`));
    }
    const r = compactHistory(msgs, {
      targetTokens: 1,
      keepRecentMessages: 10,
      toolResultHeadChars: 100,
    });
    expect(r.messages.some((m) => m.content === "THE CURRENT INSTRUCTION")).toBe(true);
    assertPairingIntact(r.messages);
  });

  it("keeps the last assistant message and its thinking blocks (signature replay)", () => {
    const lastAssistant: ChatMessageInput = {
      role: "assistant",
      content: "latest turn",
      toolCalls: [{ id: "tz", name: "tool_tz", arguments: {} }],
      thinkingBlocks: [{ thinking: "reasoning", signature: "sig-abc" }],
    };
    const msgs: ChatMessageInput[] = [
      ...Array.from({ length: 20 }, (_, i) => user(`old ${i}: ${"o".repeat(3000)}`)),
      lastAssistant,
      ...Array.from({ length: 12 }, (_, i) => toolResult("tz", `r${i}: ${"y".repeat(50)}`)),
    ];
    const r = compactHistory(msgs, {
      targetTokens: 1,
      keepRecentMessages: 10,
      toolResultHeadChars: 100,
    });
    const kept = r.messages.find((m) => m.role === "assistant");
    expect(kept).toEqual(lastAssistant);
    assertPairingIntact(r.messages);
  });

  it("caps the digest line count for very long spans", () => {
    const span = Array.from({ length: 500 }, (_, i) => user(`m${i}`));
    const digest = buildSpanDigest(span);
    expect(digest.split("\n").length).toBeLessThanOrEqual(82); // header + 80 lines + elision
    expect(digest).toContain("more messages elided");
  });
});
