// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — image bytes are bounded on their own. A flat ~1600-token count
 * per image says nothing about request size: the history's base64 data is
 * capped by {@link compactHistoryImages}, oldest images first, the recent
 * tail never touched, and nothing changes while under budget (the cached
 * prefix stays byte-identical).
 */

import { describe, expect, it } from "bun:test";
import type { ChatMessageInput } from "../provider.js";
import {
  compactHistoryImages,
  estimateHistoryImageBytes,
  IMAGE_REMOVED_NOTE,
} from "./compaction.js";

function shot(label: string, chars: number): ChatMessageInput {
  return {
    role: "user",
    content: `[Screenshot ${label}]`,
    additionalContent: [{ type: "image", base64: "A".repeat(chars), mediaType: "image/webp" }],
  };
}

describe("estimateHistoryImageBytes", () => {
  it("sums the base64 length of every image part", () => {
    const history = [shot("a", 100), { role: "assistant", content: "ok" } as const, shot("b", 50)];
    expect(estimateHistoryImageBytes(history)).toBe(150);
  });
});

describe("compactHistoryImages", () => {
  it("is a no-op under budget — same message objects, nothing rewritten", () => {
    const history = [shot("a", 100), shot("b", 100)];
    const r = compactHistoryImages(history, { budgetBytes: 1000, keepRecentMessages: 0 });
    expect(r.imagesRemoved).toBe(0);
    expect(r.messages[0]).toBe(history[0] as ChatMessageInput);
    expect(r.messages[1]).toBe(history[1] as ChatMessageInput);
  });

  it("removes the oldest images first until the budget holds, keeping the tail", () => {
    const history = [shot("1", 400), shot("2", 400), shot("3", 400), shot("4", 400)];
    const r = compactHistoryImages(history, { budgetBytes: 900, keepRecentMessages: 2 });
    expect(r.imageBytesBefore).toBe(1600);
    expect(r.imagesRemoved).toBe(2);
    expect(r.imageBytesAfter).toBe(800);
    expect(r.messages[0]?.additionalContent).toEqual([{ type: "text", text: IMAGE_REMOVED_NOTE }]);
    expect(r.messages[1]?.additionalContent).toEqual([{ type: "text", text: IMAGE_REMOVED_NOTE }]);
    expect(r.messages[2]).toBe(history[2] as ChatMessageInput);
    expect(r.messages[3]).toBe(history[3] as ChatMessageInput);
    // The text of each message survives; only the pixels go.
    expect(r.messages[0]?.content).toBe("[Screenshot 1]");
  });

  it("never touches the protected tail even when it alone exceeds the budget", () => {
    const history = [shot("1", 400), shot("2", 400)];
    const r = compactHistoryImages(history, { budgetBytes: 100, keepRecentMessages: 1 });
    expect(r.imagesRemoved).toBe(1);
    expect(r.messages[1]).toBe(history[1] as ChatMessageInput);
    expect(r.imageBytesAfter).toBe(400);
  });

  it("is deterministic — the same history compacts to the same output", () => {
    const history = [shot("1", 400), shot("2", 400), shot("3", 400)];
    const opts = { budgetBytes: 500, keepRecentMessages: 1 };
    expect(compactHistoryImages(history, opts).messages).toEqual(
      compactHistoryImages(history, opts).messages,
    );
  });
});
