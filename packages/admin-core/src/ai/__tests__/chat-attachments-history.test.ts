// SPDX-License-Identifier: MPL-2.0

/**
 * issue #190 — provider-history assembly for attached images: the most
 * recent attachment-carrying user message inlines image parts; older
 * ones downgrade to text markers; failed loads become explicit notes
 * (never a silently missing image).
 */

import { describe, expect, it } from "bun:test";
import type { ChatAttachment } from "@caelo-cms/shared";
import { buildProviderHistory, type HistoryMessage } from "../chat-runner/attachments.js";

const att = (n: number, alt?: string): ChatAttachment => ({
  assetId: `00000000-0000-4000-8000-00000000000${n}`,
  mime: "image/png",
  ...(alt ? { alt } : {}),
});

const msg = (
  role: "user" | "assistant",
  content: string,
  attachments?: ChatAttachment[],
): HistoryMessage => ({
  role,
  content,
  toolCalls: null,
  toolCallId: null,
  thinkingBlocks: null,
  attachments: attachments ?? null,
});

const okLoader = async (a: ChatAttachment) =>
  ({ type: "image", base64: `b64-${a.assetId.slice(-1)}`, mediaType: a.mime }) as const;

describe("buildProviderHistory (#190)", () => {
  // issue #356 — reverses #190's "most recent only" policy. Every attached
  // image is inlined for as long as its message lives in history; compaction
  // is the only remover. Replacing an older image with a marker was an edit
  // to the prompt prefix, which invalidates the cached message history from
  // that point — the policy that existed to save tokens spent a full re-read
  // each time it fired.
  it("inlines EVERY attached image, not just the most recent", async () => {
    const history = [
      msg("user", "here is my mockup", [att(1, "mockup v1")]),
      msg("assistant", "looks good"),
      msg("user", "and the revised one", [att(2)]),
    ];
    const out = await buildProviderHistory(history, okLoader);

    // The older image is still a real image part — the model can still look
    // at what it was shown earlier instead of at its own summary of it.
    expect(out[0]?.additionalContent).toEqual([
      { type: "image", base64: "b64-1", mediaType: "image/png" },
    ]);
    expect(out[0]?.content).toBe("here is my mockup");
    expect(out[0]?.content).not.toContain("[attached image:");

    expect(out[2]?.additionalContent).toEqual([
      { type: "image", base64: "b64-2", mediaType: "image/png" },
    ]);
    expect(out[2]?.content).toBe("and the revised one");
  });

  it("passes through messages without attachments untouched", async () => {
    const out = await buildProviderHistory(
      [msg("user", "plain"), msg("assistant", "reply")],
      okLoader,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "user", content: "plain" });
    expect(out[0]?.additionalContent).toBeUndefined();
  });

  it("failed loads become explicit notes, not silent omissions", async () => {
    const out = await buildProviderHistory(
      [msg("user", "check these", [att(1), att(2)])],
      async (a) =>
        a.assetId.endsWith("1") ? okLoader(a) : { failed: "storage read failed for asset 2" },
    );
    expect(out[0]?.additionalContent).toHaveLength(1);
    expect(out[0]?.content).toContain("could NOT be loaded");
    expect(out[0]?.content).toContain("storage read failed for asset 2");
    expect(out[0]?.content).toContain("Do not pretend you saw them");
  });

  it("multiple attachments on the latest message all become parts (max 4 by schema)", async () => {
    const out = await buildProviderHistory(
      [msg("user", "all four", [att(1), att(2), att(3), att(4)])],
      okLoader,
    );
    expect(out[0]?.additionalContent).toHaveLength(4);
  });
});
