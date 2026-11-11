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

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { CHAT_MAX_ATTACHMENT_BYTES, type MediaStorageAdapter } from "@caelo-cms/shared";
import sharp from "sharp";
import { getMediaStorage, setMediaStorage } from "../../media/storage.js";
import {
  buildProviderHistory,
  createMediaAttachmentLoader,
  type HistoryMessage,
} from "../chat-runner/attachments.js";
import { TOOL_IMAGE_MAX_EDGE } from "../chat-runner/tool-image.js";
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

/** A real 8×8 WebP: the loader decodes every image to check its edge (#1592). */
let tinyWebp: Uint8Array;
/** A 1200×4800 PNG: under the byte cap, over the edge the model sees. */
let tallPng: Uint8Array;
beforeAll(async () => {
  tinyWebp = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } })
      .webp()
      .toBuffer(),
  );
  tallPng = new Uint8Array(
    await sharp({ create: { width: 1200, height: 4800, channels: 3, background: "#e2e8f0" } })
      .png()
      .toBuffer(),
  );
});

const loaderFor = () =>
  createMediaAttachmentLoader({} as OperationRegistry, {} as DatabaseAdapter, {
    ...HUMAN,
    requestId: "image-bytes-per-turn",
  });

describe("createMediaAttachmentLoader (#1216)", () => {
  it("reads a chat image once per turn and shares the base64 string", async () => {
    const { adapter, reads } = countingStorage({
      "chat-images/2026-10-28/abc.webp": tinyWebp,
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

  it("fits an image over the model's edge before it reaches the history (#1592)", async () => {
    const key = "chat-images/2026-11-11/tall.png";
    useStorage(countingStorage({ [key]: tallPng }).adapter);
    const r = await loaderFor()({ storageKey: key, mime: "image/png" });
    if (!("base64" in r)) throw new Error(`expected an image, got ${JSON.stringify(r)}`);
    const meta = await sharp(Buffer.from(r.base64, "base64")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(TOOL_IMAGE_MAX_EDGE);
  });

  it("turns bytes that are no image into a note instead of an image part (#1592)", async () => {
    const key = "chat-images/2026-11-11/broken.png";
    useStorage(countingStorage({ [key]: new Uint8Array([1, 2, 3]) }).adapter);
    const r = await loaderFor()({ storageKey: key, mime: "image/png" });
    expect("failed" in r ? r.failed : "").toContain("not a readable image");
  });
});

describe("a history with an oversized attachment (#1592)", () => {
  it("replays every image within the edge, so the next turn is not refused", async () => {
    const key = "chat-images/2026-11-11/full-page.png";
    useStorage(countingStorage({ [key]: tallPng }).adapter);
    const history: HistoryMessage[] = [
      {
        role: "user",
        content: "Here is the page I mean.",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
        attachments: [{ storageKey: key, mime: "image/png" }],
      },
      {
        role: "assistant",
        content: "I see it.",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
      },
      {
        role: "user",
        content: "Change the headline.",
        toolCalls: null,
        toolCallId: null,
        thinkingBlocks: null,
      },
    ];
    const messages = await buildProviderHistory(history, loaderFor());
    const images = messages.flatMap((m) =>
      (m.additionalContent ?? []).filter((p) => p.type === "image"),
    );
    expect(images).toHaveLength(1);
    for (const image of images) {
      if (image.type !== "image") continue;
      const meta = await sharp(Buffer.from(image.base64, "base64")).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(TOOL_IMAGE_MAX_EDGE);
    }
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
