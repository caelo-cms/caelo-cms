// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — serve an AI-produced chat image (a screenshot a tool took)
 * to the transcript after a reload.
 *
 * The URL names `(session, message, attachment index)` and nothing else:
 * the storage key comes from the message row, resolved by
 * `chat.get_message_image` under the caller's identity, which only answers
 * for a chat the caller owns. So the client can neither name an object nor
 * reach another user's capture, and every miss is the same 404 (no oracle
 * for which sessions or messages exist).
 *
 * Kept free of `#lib` imports so `bun test` can exercise it directly; the
 * route file only wires the query context and the storage adapter in.
 */

import { CHAT_MAX_ATTACHMENTS, mediaSecurityHeaders } from "@caelo-cms/shared";
import type { ChatImageAddress } from "../components/chat/chat-image-url.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_RE = /^\d$/;

/** What the response needs from the Query API and the object store. */
export interface ChatImageDeps {
  /** `chat.get_message_image` as the requesting user; null on any miss. */
  resolve(address: ChatImageAddress): Promise<{ storageKey: string; mime: string } | null>;
  openStream(key: string): Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number }>;
}

/** Validate raw route params, or null when any of them is malformed. */
export function parseChatImageAddress(params: {
  sessionId?: string;
  messageId?: string;
  index?: string;
}): ChatImageAddress | null {
  const { sessionId, messageId, index } = params;
  if (!sessionId || !UUID_RE.test(sessionId)) return null;
  if (!messageId || !UUID_RE.test(messageId)) return null;
  if (!index || !INDEX_RE.test(index) || Number(index) >= CHAT_MAX_ATTACHMENTS) return null;
  return { chatSessionId: sessionId, messageId, index: Number(index) };
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Stream the image or answer 404.
 *
 * Cache: `private, no-store`. The owner check runs in this route, so a
 * browser-cached copy would be served to whoever signs in next on the same
 * browser profile without passing it (the cache key does not vary on the
 * session cookie). A transcript requests each image once per render, so
 * the cost is one request per card per page load.
 */
export async function chatImageResponse(
  deps: ChatImageDeps,
  params: { sessionId?: string; messageId?: string; index?: string },
): Promise<Response> {
  const address = parseChatImageAddress(params);
  if (!address) return notFound();
  const image = await deps.resolve(address);
  if (!image) return notFound();
  let file: { body: ReadableStream<Uint8Array>; sizeBytes: number };
  try {
    file = await deps.openStream(image.storageKey);
  } catch {
    return notFound();
  }
  return new Response(file.body, {
    status: 200,
    headers: {
      "content-type": image.mime,
      "content-length": String(file.sizeBytes),
      "cache-control": "private, no-store",
      ...mediaSecurityHeaders(image.mime),
    },
  });
}
