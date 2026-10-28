// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — image bytes are loaded once per turn and shared across SDK steps.
 *
 *   - the media loader reads each image at most once per turn (a
 *     content-addressed screenshot referenced by several messages shares one
 *     base64 string) and checks every source's size BEFORE reading it;
 *   - toSDKMessages hands the SDK the history's own base64 string instead of
 *     building a fresh `data:` URL on every step (four copies of a ~1.5 MB
 *     string per image per step before).
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { CHAT_MAX_ATTACHMENT_BYTES, type MediaStorageAdapter } from "@caelo-cms/shared";
import { getMediaStorage, setMediaStorage } from "../../media/storage.js";
import { createMediaAttachmentLoader } from "../chat-runner/attachments.js";
import type { ChatMessageInput } from "../provider.js";
import { toSDKMessages } from "../providers/_sdk-shared.js";

const HUMAN = { actorId: "00000000-0000-0000-0000-000000000001", actorKind: "human" } as const;

/** In-memory storage that counts reads; `sizes` overrides the reported size. */
function countingStorage(objects: Record<string, Uint8Array>, sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  const adapter: MediaStorageAdapter = {
    put: async () => undefined,
    get: async (key) => {
      reads.push(key);
      const o = objects[key];
      if (!o) throw new Error(`missing ${key}`);
      return o;
    },
    size: async (key) => {
      const o = objects[key];
      if (!o) throw new Error(`missing ${key}`);
      return sizes[key] ?? o.byteLength;
    },
    openStream: async () => {
      throw new Error("not used");
    },
    delete: async () => undefined,
    exists: async (key) => key in objects,
    totalSizeBytes: async () => 0,
  };
  return { adapter, reads };
}

let previous: MediaStorageAdapter | null = null;
function useStorage(adapter: MediaStorageAdapter): void {
  try {
    previous = getMediaStorage();
  } catch {
    previous = null;
  }
  setMediaStorage(adapter);
}
afterEach(() => {
  if (previous) setMediaStorage(previous);
});

const loaderFor = () =>
  createMediaAttachmentLoader({} as OperationRegistry, {} as DatabaseAdapter, {
    ...HUMAN,
    requestId: "image-bytes-per-turn",
  });

describe("createMediaAttachmentLoader (#1216)", () => {
  it("reads a chat image once per turn and shares the base64 string", async () => {
    const { adapter, reads } = countingStorage({
      "chat-images/2026-10-28/abc.webp": new Uint8Array([1, 2, 3]),
    });
    useStorage(adapter);
    const load = loaderFor();
    const att = { storageKey: "chat-images/2026-10-28/abc.webp", mime: "image/webp" as const };
    const a = await load(att);
    const b = await load({ ...att });
    expect(reads).toEqual(["chat-images/2026-10-28/abc.webp"]);
    expect("base64" in a && "base64" in b && a.base64 === b.base64).toBe(true);
  });

  it("refuses an oversized chat image from its size, without reading the bytes", async () => {
    const key = "chat-images/2026-10-28/huge.png";
    const { adapter, reads } = countingStorage(
      { [key]: new Uint8Array([0]) },
      { [key]: CHAT_MAX_ATTACHMENT_BYTES + 1 },
    );
    useStorage(adapter);
    const r = await loaderFor()({ storageKey: key, mime: "image/png" });
    expect("failed" in r ? r.failed : "").toContain("exceeds");
    expect(reads).toEqual([]);
  });
});

describe("toSDKMessages image parts (#1216)", () => {
  it("passes the history's base64 string through untouched on every step", () => {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const history: ChatMessageInput[] = [
      {
        role: "user",
        content: "[Screenshot]",
        additionalContent: [{ type: "image", base64, mediaType: "image/png" }],
      },
    ];
    const imageOf = (msgs: ReturnType<typeof toSDKMessages>) => {
      const content = msgs[0]?.content as { type: string; image?: unknown }[];
      return content.find((p) => p.type === "image")?.image;
    };
    const step1 = imageOf(toSDKMessages(history));
    const step2 = imageOf(toSDKMessages(history));
    expect(step1).toBe(base64);
    expect(step2).toBe(base64);
  });
});
