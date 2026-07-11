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
  it("inlines images ONLY on the most recent attachment-carrying user message", async () => {
    const history = [
      msg("user", "here is my mockup", [att(1, "mockup v1")]),
      msg("assistant", "looks good"),
      msg("user", "and the revised one", [att(2)]),
    ];
    const out = await buildProviderHistory(history, okLoader);
    // Older message: marker, no image parts.
    expect(out[0]?.additionalContent).toBeUndefined();
    expect(out[0]?.content).toContain("[attached image: mockup v1]");
    // Latest message: real image part, content untouched.
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
