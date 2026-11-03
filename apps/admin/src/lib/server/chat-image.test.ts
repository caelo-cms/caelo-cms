// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — the chat-image response: only a validated address reaches
 * the Query API, every miss is the same 404, and a served image carries its
 * stored type, nosniff and no caching.
 */

import { describe, expect, it } from "bun:test";
import { chatImageUrl, storedToolImage } from "../components/chat/chat-image-url.js";
import { type ChatImageDeps, chatImageResponse, parseChatImageAddress } from "./chat-image.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";
const KEY = `chat-images/2026-11-03/${"c".repeat(64)}.webp`;

function deps(over: Partial<ChatImageDeps> = {}): ChatImageDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    resolve: async (address) => {
      asked.push(address);
      return { storageKey: KEY, mime: "image/webp" };
    },
    openStream: async () => ({
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      sizeBytes: 3,
    }),
    ...over,
  };
}

describe("chat image route (#359)", () => {
  it("streams the stored image with its type, nosniff and no caching", async () => {
    const d = deps();
    const res = await chatImageResponse(d, { sessionId: SESSION, messageId: MESSAGE, index: "0" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(d.asked).toEqual([{ chatSessionId: SESSION, messageId: MESSAGE, index: 0 }]);
  });

  it("404s malformed params without asking the Query API", async () => {
    const d = deps();
    for (const params of [
      { sessionId: "..", messageId: MESSAGE, index: "0" },
      { sessionId: SESSION, messageId: "../../etc", index: "0" },
      { sessionId: SESSION, messageId: MESSAGE, index: "4" },
      { sessionId: SESSION, messageId: MESSAGE, index: "-1" },
      { sessionId: SESSION, messageId: MESSAGE, index: "01" },
      { sessionId: SESSION, messageId: MESSAGE },
    ]) {
      const res = await chatImageResponse(d, params);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(d.asked).toEqual([]);
  });

  it("404s a chat the caller cannot read and an object the store no longer has", async () => {
    const params = { sessionId: SESSION, messageId: MESSAGE, index: "0" };
    expect((await chatImageResponse(deps({ resolve: async () => null }), params)).status).toBe(404);
    const gone = deps({
      openStream: async () => {
        throw new Error("ENOENT");
      },
    });
    expect((await chatImageResponse(gone, params)).status).toBe(404);
  });

  it("parses a valid address", () => {
    expect(parseChatImageAddress({ sessionId: SESSION, messageId: MESSAGE, index: "3" })).toEqual({
      chatSessionId: SESSION,
      messageId: MESSAGE,
      index: 3,
    });
  });
});

describe("storedToolImage (#359)", () => {
  it("points a tool row's stored image at the chat's images route", () => {
    expect(
      storedToolImage(SESSION, {
        id: MESSAGE,
        attachments: [{ storageKey: KEY, mime: "image/webp" }],
      }),
    ).toEqual({
      src: chatImageUrl({ chatSessionId: SESSION, messageId: MESSAGE, index: 0 }),
      mediaType: "image/webp",
    });
    expect(chatImageUrl({ chatSessionId: SESSION, messageId: MESSAGE, index: 0 })).toBe(
      `/content/chat/${SESSION}/images/${MESSAGE}/0`,
    );
  });

  it("is undefined for rows without a stored image", () => {
    expect(storedToolImage(SESSION, { id: MESSAGE })).toBeUndefined();
    expect(storedToolImage(SESSION, { id: MESSAGE, attachments: null })).toBeUndefined();
    expect(
      storedToolImage(SESSION, { id: MESSAGE, attachments: [{ mime: "image/png" }] }),
    ).toBeUndefined();
  });
});
